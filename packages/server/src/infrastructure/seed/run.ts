import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sql } from 'kysely';
import { loadConfig } from '../../bootstrap/config.js';
import { createDatabaseRuntime } from '../database/runtime.js';
import { maintenanceDatabaseRuntimeOptions } from '../database/maintenance-options.js';
import { createUnitOfWork } from '../database/unit-of-work.js';
import { loadManifest, SeedError } from './manifest.js';
import { applySeed, adoptSeed } from './injector.js';
import { withdrawSeed } from './withdrawer.js';
import { prefixCount } from './helpers.js';
import { createPostgresReportSourceInvalidationOutboxPort } from '../outbox/index.js';

/**
 * Seed 数据管理 CLI（与 migrate 同构的一次性服务入口）。
 *
 * 用法：
 *   node dist/src/infrastructure/seed/run.js --status
 *   node dist/src/infrastructure/seed/run.js --apply    [--allow-cascade] [--clean-dangling]
 *   node dist/src/infrastructure/seed/run.js --withdraw [--allow-cascade] [--clean-dangling]
 *   node dist/src/infrastructure/seed/run.js --adopt
 *
 * 环境变量：SEED_DIR（数据包目录，默认 /app/seed/demo）、SEED_VERSION（--apply/--adopt 必填）、
 *           SEED_BY（来源标记，默认 cli）、KNOWN_DEMO_PASSWORD（--apply 时 auth 阶段必填：
 *           dev-only demo 密码输入，seed 时经 Argon2id 哈希，不写入仓库、不回显）。
 */

export interface SeedCliOptions {
  command: 'apply' | 'withdraw' | 'status' | 'adopt';
  seedDir: string;
  version: string;
  by: string;
  allowCascade: boolean;
  cleanDangling: boolean;
}

function usage(): never {
  process.stderr.write(
    '用法: run.js <--apply|--withdraw|--status|--adopt> [--seed-dir <dir>] '
    + '[--seed-version <sha>] [--allow-cascade] [--clean-dangling] [--by <label>]\n',
  );
  process.exit(2);
}

function parseArgs(arguments_: readonly string[]): SeedCliOptions {
  const options: SeedCliOptions = {
    command: 'status',
    seedDir: process.env.SEED_DIR ?? '/app/seed/demo',
    version: process.env.SEED_VERSION ?? '',
    by: process.env.SEED_BY ?? 'cli',
    allowCascade: false,
    cleanDangling: false,
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const arg = arguments_[index]!;
    switch (arg) {
      case '--apply': options.command = 'apply'; break;
      case '--withdraw': options.command = 'withdraw'; break;
      case '--status': options.command = 'status'; break;
      case '--adopt': options.command = 'adopt'; break;
      case '--allow-cascade': options.allowCascade = true; break;
      case '--clean-dangling': options.cleanDangling = true; break;
      case '--seed-dir': options.seedDir = arguments_[++index] ?? usage(); break;
      case '--seed-version': options.version = arguments_[++index] ?? usage(); break;
      case '--by': options.by = arguments_[++index] ?? usage(); break;
      default: usage();
    }
  }
  if (options.command !== 'status' && !options.version) {
    process.stderr.write('错误: --apply/--withdraw/--adopt 需要 SEED_VERSION（或 --seed-version）\n');
    process.exit(2);
  }
  return options;
}

function formatCounts(counts: Record<string, number>): string {
  return Object.entries(counts).map(([table, count]) => `${table}=${count}`).join(' ');
}

export async function seedCli(arguments_: readonly string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(arguments_);
  const seedDir = resolve(options.seedDir);
  const manifest = loadManifest(seedDir);
  const config = loadConfig();
  const reportSourceInvalidation = config.reports.enabled
    && config.cache.redis.mode !== 'off'
    && (config.cache.reports.metadataEnabled
      || config.cache.reports.issuesEnabled
      || config.cache.reports.directoryEnabled)
    ? createPostgresReportSourceInvalidationOutboxPort() : undefined;
  const runtime = createDatabaseRuntime(config.databaseUrl, {
    applicationName: 'known-seed',
    production: config.nodeEnv === 'production',
    ssl: config.databaseSsl,
    ...maintenanceDatabaseRuntimeOptions(),
  });
  try {
    if (options.command === 'status') {
      await showStatus(runtime, manifest);
      return;
    }
    if (options.command === 'apply') {
      const report = await applySeed(runtime, manifest, {
        version: options.version,
        by: options.by,
        allowCascade: options.allowCascade,
        cleanDangling: options.cleanDangling,
        ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
      });
      if (report.skipped) {
        console.log(`SKIP: seed「${manifest.key}」版本 ${options.version} 已应用，未重复注入。`);
      } else {
        console.log(`OK: seed「${manifest.key}」版本 ${options.version} 注入完成，新增 ${report.insertedRows} 行。`);
        console.log(`    计数: ${formatCounts(report.tableCounts)}`);
        if (report.authAccounts && report.authAccounts.length > 0) {
          // seed 输出只显示 account id 和 email，不显示任何凭据
          console.log(`    demo 账号: ${report.authAccounts.map((item) => `${item.accountId}(${item.email})`).join(', ')}`);
        }
        if (report.withdrawReport) {
          printWithdrawSummary('已随换版撤回旧版本', report.withdrawReport);
        }
      }
      return;
    }
    if (options.command === 'withdraw') {
      const report = await withdrawSeed(runtime, manifest, {
        by: options.by,
        allowCascade: options.allowCascade,
        cleanDangling: options.cleanDangling,
        ...(reportSourceInvalidation === undefined ? {} : { reportSourceInvalidation }),
      });
      printWithdrawSummary(`OK: seed「${manifest.key}」版本 ${report.version} 已撤回`, report);
      return;
    }
    // adopt
    const adopted = await adoptSeed(runtime, manifest, { version: options.version, by: options.by });
    console.log(`OK: 已认领存量数据为版本 ${adopted.version}，登记 ${adopted.adoptedRows} 行。`);
  } catch (error) {
    if (error instanceof SeedError) {
      process.stderr.write(`SEED_ERROR[${error.code}]: ${error.message}\n`);
      process.exitCode = 1;
    } else {
      throw error;
    }
  } finally {
    await runtime.close();
  }
}

function printWithdrawSummary(prefix: string, report: { version: string; cascade: Array<{ label: string; count: number }>; dangling: Array<{ label: string; count: number; cleaned: boolean }>; auto: Array<{ label: string; count: number }>; retained?: Array<{ label: string; count: number }>; deletedRows: number; tableCounts: Record<string, number> }): void {
  console.log(`${prefix}（${report.version}），删除登记行 ${report.deletedRows} 条。`);
  for (const item of report.cascade) console.log(`    级联: ${item.label}（${item.count} 条将被级联删除）`);
  for (const item of report.auto) console.log(`    自动清理: ${item.label}（${item.count} 条）`);
  for (const item of report.retained ?? []) console.log(`    保留: ${item.label}（${item.count} 条永久事实，随软删收藏夹保留）`);
  for (const item of report.dangling) {
    console.log(`    悬空: ${item.label}（${item.count} 条${item.cleaned ? '，已清理' : '，未清理'}）`);
  }
  console.log(`    撤回后前缀计数: ${formatCounts(report.tableCounts)}`);
}

async function showStatus(
  runtime: ReturnType<typeof createDatabaseRuntime>,
  manifest: ReturnType<typeof loadManifest>,
): Promise<void> {
  await createUnitOfWork(runtime.db).execute(async ({ transaction }) => {
  const applied = await sql<{
    seed_key: string;
    version: string;
    state: string;
    applied_at: Date;
    withdrawn_at: Date | null;
    applied_by: string | null;
  }>`
    SELECT seed_key, version, state, applied_at, withdrawn_at, applied_by
    FROM seed_applied WHERE seed_key = ${manifest.key}
  `.execute(transaction);
  const rows = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM seed_rows WHERE seed_key = ${manifest.key}
  `.execute(transaction);
  console.log(`seed「${manifest.key}」${manifest.name}`);
  if (applied.rows.length === 0) {
    console.log('  状态: 未应用');
  } else {
    const row = applied.rows[0]!;
    console.log(`  状态: ${row.state}（版本 ${row.version}，${row.applied_at.toISOString()}，by ${row.applied_by ?? '-'}${row.withdrawn_at ? `，撤回于 ${row.withdrawn_at.toISOString()}` : ''}）`);
  }
  console.log(`  登记行: ${rows.rows[0]!.n}`);
  const counts: Record<string, number> = {};
  for (const spec of manifest.tables) {
    counts[spec.table] = await prefixCount(transaction, spec.table, spec.prefixSql);
  }
  console.log(`  前缀计数: ${formatCounts(counts)}`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  seedCli().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
