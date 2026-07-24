import { StorageCore } from 'src/cores/storage.core';
import { StorageFolder } from 'src/enum';
import { vitest } from 'vitest';

vitest.mock('src/constants', () => ({
  IWorker: 'IWorker',
}));

describe('StorageCore', () => {
  describe('isImmichPath', () => {
    beforeEach(() => {
      StorageCore.setMediaLocation('/photos');
    });

    it('should return true for APP_MEDIA_LOCATION path', () => {
      const immichPath = '/photos';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return true for paths within the APP_MEDIA_LOCATION', () => {
      const immichPath = '/photos/new/';
      expect(StorageCore.isImmichPath(immichPath)).toBe(true);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION and same starts', () => {
      const nonImmichPath = '/photos_new';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should return false for paths outside the APP_MEDIA_LOCATION', () => {
      const nonImmichPath = '/some/other/path';
      expect(StorageCore.isImmichPath(nonImmichPath)).toBe(false);
    });

    it('should treat overridden S3 folder roots as managed paths', () => {
      StorageCore.setStorageLayout({
        mediaLocation: 's3://immich-test/data',
        folders: {
          [StorageFolder.Upload]: 's3://immich-test/data/upload',
          [StorageFolder.Library]: 's3://immich-test/data/library',
          [StorageFolder.EncodedVideo]: 's3://immich-test/cache/encoded-video',
          [StorageFolder.Profile]: 's3://immich-test/cache/profile',
          [StorageFolder.Thumbnails]: 's3://immich-test/cache/thumbs',
          [StorageFolder.Backups]: 's3://immich-test/ops/backups',
        },
      });

      expect(StorageCore.getBaseFolder(StorageFolder.Thumbnails)).toBe('s3://immich-test/cache/thumbs');
      expect(StorageCore.isImmichPath('s3://immich-test/cache/thumbs/user/aa/bb/file.webp')).toBe(true);
      expect(StorageCore.isImmichPath('s3://immich-test/data/library/user/file.jpg')).toBe(true);
      expect(StorageCore.isImmichPath('s3://different-bucket/cache/thumbs/file.webp')).toBe(false);
    });
  });
});
