import { StorageFolder, SystemMetadataKey } from 'src/enum';
import { S3AppStorageBackend } from 'src/storage/s3-backend';
import { StorageService } from 'src/services/storage.service';
import { ImmichStartupError } from 'src/utils/misc';
import { mockEnvData } from 'test/repositories/config.repository.mock';
import { newTestService, ServiceMocks } from 'test/utils';
import { vitest } from 'vitest';

describe(StorageService.name, () => {
  let sut: StorageService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(StorageService));
  });

  afterEach(() => {
    vitest.restoreAllMocks();
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrap', () => {
    it('should enable mount folder checking', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/encoded-video'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/thumbs'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/encoded-video/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/profile/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/thumbs/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/upload/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should enable mount folder checking for a new folder type', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        mountChecks: {
          backups: false,
          'encoded-video': true,
          library: false,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/data',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, {
        mountChecks: {
          backups: true,
          'encoded-video': true,
          library: true,
          profile: true,
          thumbs: true,
          upload: true,
        },
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledTimes(2);
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/library'));
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/backups'));
      expect(mocks.storage.createFile).toHaveBeenCalledTimes(2);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/library/.immich'),
        expect.any(Buffer),
      );
      expect(mocks.storage.createFile).toHaveBeenCalledWith(
        expect.stringContaining('/data/backups/.immich'),
        expect.any(Buffer),
      );
    });

    it('should throw an error if .immich is missing', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.readFile.mockRejectedValue(new Error("ENOENT: no such file or directory, open '/app/.immich'"));

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to read');

      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should throw an error if .immich is present but read-only', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).rejects.toThrow('Failed to write');

      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should skip mount file creation if file already exists', async () => {
      const error = new Error('Error creating file') as any;
      error.code = 'EEXIST';
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(error);
      mocks.asset.getFileSamples.mockResolvedValue([]);

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.logger.warn).toHaveBeenCalledWith('Found existing mount file, skipping creation');
    });

    it('should throw an error if mount file could not be created', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: {} });
      mocks.storage.createFile.mockRejectedValue(new Error('Error creating file'));

      await expect(sut.onBootstrap()).rejects.toBeInstanceOf(ImmichStartupError);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should startup if checks are disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ mountChecks: { upload: true } });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: { ignoreMountCheckErrors: true },
        }),
      );
      mocks.asset.getFileSamples.mockResolvedValue([]);
      mocks.storage.overwriteFile.mockRejectedValue(
        new Error("ENOENT: no such file or directory, open '/app/.immich'"),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.SystemFlags, expect.anything());
    });

    it('should preserve legacy local media-location migration behavior', async () => {
      mocks.systemMetadata.get.mockImplementation(async (key) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return { mountChecks: {} };
        }

        if (key === SystemMetadataKey.MediaLocation) {
          return { location: '/old-data' };
        }

        return null;
      });
      mocks.asset.getFileSamples.mockResolvedValue([{ assetId: 'asset-1', path: '/old-data/thumbs/file.webp' }]);
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            mediaLocation: '/new-data',
            engine: 'local',
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.database.migrateFilePaths).toHaveBeenCalledWith('/old-data', '/new-data');
      expect(mocks.database.migrateStorageFolderPaths).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.MediaLocation, { location: '/new-data' });
    });

    it('should migrate only changed S3 managed folder roots and persist the storage layout', async () => {
      vitest.spyOn(S3AppStorageBackend.prototype, 'listRecursive').mockResolvedValue([]);
      mocks.systemMetadata.get.mockImplementation(async (key) => {
        if (key === SystemMetadataKey.SystemFlags) {
          return null;
        }

        if (key === SystemMetadataKey.MediaLocation) {
          return { location: 's3://immich-test/data' };
        }

        if (key === SystemMetadataKey.StorageLayout) {
          return {
            mediaLocation: 's3://immich-test/data',
            folders: {
              [StorageFolder.Upload]: 's3://immich-test/data/upload',
              [StorageFolder.Library]: 's3://immich-test/data/library',
              [StorageFolder.EncodedVideo]: 's3://immich-test/data/encoded-video',
              [StorageFolder.Profile]: 's3://immich-test/data/profile',
              [StorageFolder.Thumbnails]: 's3://immich-test/data/thumbs',
              [StorageFolder.Backups]: 's3://immich-test/data/backups',
            },
          };
        }

        return null;
      });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            ignoreMountCheckErrors: false,
            engine: 's3',
            s3: {
              bucket: 'immich-test',
              region: 'us-east-1',
              prefix: 'data',
              thumbPrefix: 'cache/thumbs',
              profilePrefix: 'profiles',
            },
          },
        }),
      );

      await expect(sut.onBootstrap()).resolves.toBeUndefined();

      expect(mocks.database.migrateStorageFolderPaths).toHaveBeenCalledWith(
        StorageFolder.Thumbnails,
        's3://immich-test/data/thumbs',
        's3://immich-test/cache/thumbs',
      );
      expect(mocks.database.migrateStorageFolderPaths).toHaveBeenCalledWith(
        StorageFolder.Profile,
        's3://immich-test/data/profile',
        's3://immich-test/profiles',
      );
      expect(mocks.database.migrateStorageFolderPaths).toHaveBeenCalledTimes(2);
      expect(mocks.database.migrateFilePaths).not.toHaveBeenCalled();
      expect(mocks.systemMetadata.set).not.toHaveBeenCalledWith(SystemMetadataKey.MediaLocation, expect.anything());
      expect(mocks.systemMetadata.set).toHaveBeenCalledWith(SystemMetadataKey.StorageLayout, {
        mediaLocation: 's3://immich-test/data',
        folders: {
          [StorageFolder.Upload]: 's3://immich-test/data/upload',
          [StorageFolder.Library]: 's3://immich-test/data/library',
          [StorageFolder.EncodedVideo]: 's3://immich-test/data/encoded-video',
          [StorageFolder.Profile]: 's3://immich-test/profiles',
          [StorageFolder.Thumbnails]: 's3://immich-test/cache/thumbs',
          [StorageFolder.Backups]: 's3://immich-test/data/backups',
        },
      });
    });
  });

  describe('handleDeleteFiles', () => {
    it('should handle null values', async () => {
      await sut.handleDeleteFiles({ files: [undefined, null] });

      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('should handle an error removing a file', async () => {
      mocks.storage.unlink.mockRejectedValue(new Error('something-went-wrong'));

      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });

    it('should remove the file', async () => {
      await sut.handleDeleteFiles({ files: ['path/to/something'] });

      expect(mocks.storage.unlink).toHaveBeenCalledWith('path/to/something');
    });
  });
});
