import { Writable, Readable } from 'stream';
import * as fse from 'fs-extra';
import path from 'path';
import { isFunction } from 'lodash/fp';
import type {
  IAsset,
  IDestinationProvider,
  IFile,
  IMetadata,
  ProviderType,
  Transaction,
} from '../../../../types';

import { restore } from './strategies';
import * as utils from '../../../utils';
import { ProviderTransferError, ProviderValidationError } from '../../../errors/providers';
import { assertValidStrapi } from '../../../utils/providers';

export const VALID_CONFLICT_STRATEGIES = ['restore', 'merge'];
export const DEFAULT_CONFLICT_STRATEGY = 'restore';

export interface ILocalStrapiDestinationProviderOptions {
  getStrapi(): Strapi.Strapi | Promise<Strapi.Strapi>; // return an initialized instance of Strapi

  autoDestroy?: boolean; // shut down the instance returned by getStrapi() at the end of the transfer
  restore?: restore.IRestoreOptions; // erase all data in strapi database before transfer
  strategy: 'restore'; // conflict management strategy; only the restore strategy is available at this time
}

const streamToBuffer = (stream: any): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on('data', (chunk: any) => {
      chunks.push(chunk);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', reject);
  });

class LocalStrapiDestinationProvider implements IDestinationProvider {
  name = 'destination::local-strapi';

  type: ProviderType = 'destination';

  options: ILocalStrapiDestinationProviderOptions;

  strapi?: Strapi.Strapi;

  transaction?: Transaction;

  uploadsBackupDirectoryName: string;

  /**
   * The entities mapper is used to map old entities to their new IDs
   */
  #entitiesMapper: { [type: string]: { [id: number]: number } };

  constructor(options: ILocalStrapiDestinationProviderOptions) {
    this.options = options;
    this.#entitiesMapper = {};
    this.uploadsBackupDirectoryName = `uploads_backup_${Date.now()}`;
  }

  async bootstrap(): Promise<void> {
    this.#validateOptions();
    this.strapi = await this.options.getStrapi();

    this.transaction = utils.transaction.createTransaction(this.strapi);
  }

  async close(): Promise<void> {
    const { autoDestroy } = this.options;
    this.transaction?.end();

    // Basically `!== false` but more deterministic
    if (autoDestroy === undefined || autoDestroy === true) {
      await this.strapi?.destroy();
    }
  }

  #validateOptions() {
    if (!VALID_CONFLICT_STRATEGIES.includes(this.options.strategy)) {
      throw new ProviderValidationError(`Invalid strategy ${this.options.strategy}`, {
        check: 'strategy',
        strategy: this.options.strategy,
        validStrategies: VALID_CONFLICT_STRATEGIES,
      });
    }
  }

  async #deleteAll() {
    assertValidStrapi(this.strapi);
    return restore.deleteRecords(this.strapi, this.options.restore);
  }

  async #deleteAllAssets() {
    assertValidStrapi(this.strapi);
    // delete all the assets (if local: remove uplaods folder, if external: remove using the provider api)
    // query files and do for loop to delete them using the delete method in provider
    if (strapi.config.get('plugin.upload').provider === 'local') {
      const uploadsDirectory = path.join(
        this.strapi.dirs.static.public,
        this.uploadsBackupDirectoryName
      );
      await fse.rm(uploadsDirectory, { recursive: true, force: true });
    } else {
      // external providers

      // TODO use bulk delete when exists in providers
      const files: IFile[] = await strapi.query('plugin::upload.file').findMany();
      for (const file of files) {
        await strapi.plugin('upload').provider.delete(file);
        if (file.formats) {
          for (const fileFormat of Object.values(file.formats)) {
            await strapi.plugin('upload').provider.delete(fileFormat);
          }
        }
      }
    }
  }

  async rollback() {
    await this.transaction?.rollback();
  }

  async beforeTransfer() {
    if (!this.strapi) {
      throw new Error('Strapi instance not found');
    }

    await this.transaction?.attach(async () => {
      await this.#handleAssetsBackup();
      try {
        if (this.options.strategy === 'restore') {
          await this.#deleteAllAssets();
          await this.#deleteAll();
        }
      } catch (error) {
        throw new Error(`restore failed ${error}`);
      }
    });
  }

  getMetadata(): IMetadata {
    const strapiVersion = strapi.config.get('info.strapi');
    const createdAt = new Date().toISOString();

    return {
      createdAt,
      strapi: {
        version: strapiVersion,
      },
    };
  }

  getSchemas() {
    assertValidStrapi(this.strapi, 'Not able to get Schemas');
    const schemas = {
      ...this.strapi.contentTypes,
      ...this.strapi.components,
    };

    return utils.schema.mapSchemasValues(schemas);
  }

  createEntitiesWriteStream(): Writable {
    assertValidStrapi(this.strapi, 'Not able to import entities');
    const { strategy } = this.options;

    const updateMappingTable = (type: string, oldID: number, newID: number) => {
      if (!this.#entitiesMapper[type]) {
        this.#entitiesMapper[type] = {};
      }

      Object.assign(this.#entitiesMapper[type], { [oldID]: newID });
    };

    if (strategy === 'restore') {
      return restore.createEntitiesWriteStream({
        strapi: this.strapi,
        updateMappingTable,
        transaction: this.transaction,
      });
    }

    throw new ProviderValidationError(`Invalid strategy ${this.options.strategy}`, {
      check: 'strategy',
      strategy: this.options.strategy,
      validStrategies: VALID_CONFLICT_STRATEGIES,
    });
  }

  async #handleAssetsBackup() {
    assertValidStrapi(this.strapi, 'Not able to create the assets backup');

    if (strapi.config.get('plugin.upload').provider === 'local') {
      const assetsDirectory = path.join(this.strapi.dirs.static.public, 'uploads');
      const backupDirectory = path.join(
        this.strapi.dirs.static.public,
        this.uploadsBackupDirectoryName
      );

      try {
        await fse.move(assetsDirectory, backupDirectory);
        await fse.mkdir(assetsDirectory);
        // Create a .gitkeep file to ensure the directory is not empty
        await fse.outputFile(path.join(assetsDirectory, '.gitkeep'), '');
      } catch (err) {
        throw new ProviderTransferError(
          'The backup folder for the assets could not be created inside the public folder. Please ensure Strapi has write permissions on the public directory'
        );
      }
      return backupDirectory;
    }
  }

  async #removeAssetsBackup() {
    if (strapi.config.get('plugin.upload').provider === 'local') {
      assertValidStrapi(this.strapi);
      const backupDirectory = path.join(
        this.strapi.dirs.static.public,
        this.uploadsBackupDirectoryName
      );
      await fse.rm(backupDirectory, { recursive: true, force: true });
    }
  }

  // TODO: Move this logic to the restore strategy
  async createAssetsWriteStream(): Promise<Writable> {
    assertValidStrapi(this.strapi, 'Not able to stream Assets');

    const removeAssetsBackup = this.#removeAssetsBackup.bind(this);
    const strapi = this.strapi;
    const transaction = this.transaction;
    return new Writable({
      objectMode: true,
      async final(next) {
        // Deletes the backup folder
        removeAssetsBackup();
        next();
      },
      async write(chunk: IAsset, _encoding, callback) {
        await transaction?.attach(async () => {
          const uploadData = {
            ...chunk.metadata,
            stream: Readable.from(chunk.stream),
            buffer: chunk?.buffer,
          };

          const provider = strapi.config.get('plugin.upload').provider;

          try {
            if (isFunction(strapi.plugin('upload').provider.uploadStream)) {
              await strapi.plugin('upload').provider.uploadStream(uploadData);
            } else {
              uploadData.buffer = await streamToBuffer(uploadData.stream);
              await strapi.plugin('upload').provider.upload(uploadData);
            }
            if (uploadData?.type) {
              const entry: IFile = await strapi.db.query('plugin::upload.file').findOne({
                where: { hash: uploadData.mainHash },
              });
              const specificFormat = entry?.formats?.[uploadData.type];
              if (specificFormat) {
                specificFormat.url = uploadData.url;
              }
              await strapi.db.query('plugin::upload.file').update({
                where: { hash: uploadData.mainHash },
                data: {
                  formats: entry.formats,
                  provider,
                },
              });
              return callback();
            }
            const entry: IFile = await strapi.db.query('plugin::upload.file').findOne({
              where: { hash: uploadData.hash },
            });
            entry.url = uploadData.url;
            await strapi.db.query('plugin::upload.file').update({
              where: { hash: uploadData.hash },
              data: {
                url: entry.url,
                provider,
              },
            });
            callback();
          } catch (error) {
            callback(new Error(`Error while uploading asset ${chunk.filename}`));
          }
        });
      },
    });
  }

  async createConfigurationWriteStream(): Promise<Writable> {
    assertValidStrapi(this.strapi, 'Not able to stream Configurations');

    const { strategy } = this.options;

    if (strategy === 'restore') {
      return restore.createConfigurationWriteStream(this.strapi, this.transaction);
    }

    throw new ProviderValidationError(`Invalid strategy ${strategy}`, {
      check: 'strategy',
      strategy,
      validStrategies: VALID_CONFLICT_STRATEGIES,
    });
  }

  async createLinksWriteStream(): Promise<Writable> {
    if (!this.strapi) {
      throw new Error('Not able to stream links. Strapi instance not found');
    }

    const { strategy } = this.options;
    const mapID = (uid: string, id: number): number | undefined => this.#entitiesMapper[uid]?.[id];

    if (strategy === 'restore') {
      return restore.createLinksWriteStream(mapID, this.strapi, this.transaction);
    }

    throw new ProviderValidationError(`Invalid strategy ${strategy}`, {
      check: 'strategy',
      strategy,
      validStrategies: VALID_CONFLICT_STRATEGIES,
    });
  }
}

export const createLocalStrapiDestinationProvider = (
  options: ILocalStrapiDestinationProviderOptions
) => {
  return new LocalStrapiDestinationProvider(options);
};
