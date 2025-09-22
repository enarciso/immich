import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('node:child_process', () => ({
  spawnSync: vi.fn(() => ({ status: 0 })),
}));

// Mock SDK and utils
vi.mock('@immich/sdk', () => ({
  searchLargeAssets: vi.fn(),
}));

vi.mock('src/utils', async () => {
  const actual = await vi.importActual<any>('src/utils');
  return {
    ...actual,
    authenticate: vi.fn(),
  };
});

import { searchLargeAssets } from '@immich/sdk';
import { spawnSync } from 'node:child_process';
import * as utils from 'src/utils';
import { storageS3Migrate, storageS3Plan, storageS3Verify } from 'src/commands/storage';

describe('storage s3-plan', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('prints aws and s5cmd examples', async () => {
    await storageS3Plan(
      { configDirectory: '/tmp' } as any,
      { mediaBase: '/data/immich', bucket: 'my-bucket', prefix: 'immich', tool: 'both', profile: 'dev' },
    );

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('aws s3 sync "/data/immich/" "s3://my-bucket/immich/"');
    expect(output).toContain('s5cmd --numworkers 32 sync "/data/immich/" "s3://my-bucket/immich/"');
    expect(output).toContain('AWS profile: dev');
  });
});

describe('storage s3-migrate', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(spawnSync).mockReset();
    vi.mocked(spawnSync).mockReturnValue({ status: 0 } as any);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });
  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('invokes aws s3 sync with dry-run and profile', async () => {
    await storageS3Migrate(
      { configDirectory: '/tmp' } as any,
      { mediaBase: '/data/immich', bucket: 'my-bucket', prefix: 'immich', tool: 'aws', dryRun: true, profile: 'dev' },
    );

    expect(spawnSync).toHaveBeenCalled();
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[0]).toBe('aws');
    expect(call[1]).toEqual(
      expect.arrayContaining(['s3', 'sync', '/data/immich/', 's3://my-bucket/immich/', '--only-show-errors', '--dryrun']),
    );
    expect(call[2]).toMatchObject({ stdio: 'inherit' });
    expect((call[2] as any).env.AWS_PROFILE).toBe('dev');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('invokes s5cmd sync with concurrency and dry-run', async () => {
    await storageS3Migrate(
      { configDirectory: '/tmp' } as any,
      { mediaBase: '/data/immich', bucket: 'buck', prefix: 'pre', tool: 's5cmd', concurrency: 16, dryRun: true },
    );
    const call = vi.mocked(spawnSync).mock.calls[0];
    expect(call[0]).toBe('s5cmd');
    expect(call[1]).toEqual(expect.arrayContaining(['--numworkers', '16', 'sync', '/data/immich/', 's3://buck/pre/']));
    expect(call[1]).toContain('-n');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('auto-selects s5cmd when available', async () => {
    // First call: hasCmd('s5cmd') probe
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0 } as any) // s5cmd --version
      .mockReturnValueOnce({ status: 0 } as any); // s5cmd sync

    await storageS3Migrate(
      { configDirectory: '/tmp' } as any,
      { mediaBase: '/data/immich', bucket: 'buck', prefix: 'pre', tool: 'auto' },
    );

    const calls = vi.mocked(spawnSync).mock.calls;
    expect(calls[0][0]).toBe('s5cmd');
    expect(calls[0][1]).toEqual(['--version']);
    expect(calls[1][0]).toBe('s5cmd');
    expect(calls[1][1]).toEqual(expect.arrayContaining(['sync', '/data/immich/', 's3://buck/pre/']));
    expect(exitSpy).toHaveBeenCalledWith(0);
  });
});

describe('storage s3-verify', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(utils.authenticate).mockResolvedValue({ url: 'http://immich.test', key: 'k' } as any);
  });
  afterEach(() => {
    logSpy.mockRestore();
  });

  it('reports counts and prefix matches', async () => {
    vi.mocked(searchLargeAssets).mockResolvedValue([
      { id: '1', originalPath: 's3://my-bucket/immich/a.jpg' },
      { id: '2', originalPath: 's3://my-bucket/immich/b.jpg' },
      { id: '3', originalPath: '/data/immich/c.jpg' },
    ] as any);

    await storageS3Verify({ configDirectory: '/tmp' } as any, {
      sample: 3,
      expectPrefix: 's3://my-bucket/immich',
    });

    const output = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(output).toContain('Sample size: 3');
    expect(output).toContain('S3-backed assets: 2');
    expect(output).toContain('Matching prefix (s3://my-bucket/immich): 2');
    expect(output).toContain('WARN');
  });
});

