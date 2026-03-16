/**
 * Step: container — Build container image and verify with test run.
 * Replaces 03-setup-container.sh
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from '../src/logger.js';
import { commandExists } from './platform.js';
import { emitStatus } from './status.js';

function parseArgs(args: string[]): { runtime: string } {
  let runtime = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runtime' && args[i + 1]) {
      runtime = args[i + 1];
      i++;
    }
  }
  return { runtime };
}

function persistContainerRuntime(projectRoot: string, runtime: string): void {
  const envFile = path.join(projectRoot, '.env');
  let envContent = '';
  if (fs.existsSync(envFile)) {
    envContent = fs.readFileSync(envFile, 'utf-8');
  }

  if (/^CONTAINER_RUNTIME=/m.test(envContent)) {
    envContent = envContent.replace(
      /^CONTAINER_RUNTIME=.*$/m,
      `CONTAINER_RUNTIME=${runtime}`,
    );
  } else {
    envContent = envContent.trimEnd();
    envContent = envContent
      ? `${envContent}\nCONTAINER_RUNTIME=${runtime}\n`
      : `CONTAINER_RUNTIME=${runtime}\n`;
  }

  fs.writeFileSync(envFile, envContent);
}

export async function run(args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const { runtime } = parseArgs(args);
  const image = 'nanoclaw-agent:latest';
  const logFile = path.join(projectRoot, 'logs', 'setup.log');

  if (!runtime) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: 'unknown',
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'missing_runtime_flag',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  // Validate runtime availability
  if (runtime === 'apple-container' && !commandExists('container')) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'runtime_not_available',
      LOG: 'logs/setup.log',
    });
    process.exit(2);
  }

  if (runtime === 'docker') {
    if (!commandExists('docker')) {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore' });
    } catch {
      emitStatus('SETUP_CONTAINER', {
        RUNTIME: runtime,
        IMAGE: image,
        BUILD_OK: false,
        TEST_OK: false,
        STATUS: 'failed',
        ERROR: 'runtime_not_available',
        LOG: 'logs/setup.log',
      });
      process.exit(2);
    }
  }

  if (!['apple-container', 'docker'].includes(runtime)) {
    emitStatus('SETUP_CONTAINER', {
      RUNTIME: runtime,
      IMAGE: image,
      BUILD_OK: false,
      TEST_OK: false,
      STATUS: 'failed',
      ERROR: 'unknown_runtime',
      LOG: 'logs/setup.log',
    });
    process.exit(4);
  }

  const buildCmd =
    runtime === 'apple-container' ? 'container build' : 'docker build';
  const runCmd = runtime === 'apple-container' ? 'container' : 'docker';

  // Build
  let buildOk = false;
  logger.info({ runtime }, 'Building container');
  try {
    const buildParts = buildCmd.split(' ');
    execFileSync(buildParts[0], [...buildParts.slice(1), '-t', image, '.'], {
      cwd: path.join(projectRoot, 'container'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    buildOk = true;
    logger.info('Container build succeeded');
  } catch (err) {
    logger.error({ err }, 'Container build failed');
  }

  // Test
  let testOk = false;
  if (buildOk) {
    logger.info('Testing container');
    try {
      const output = execFileSync(
        runCmd,
        [
          'run',
          '-i',
          '--rm',
          '--entrypoint',
          '/bin/echo',
          image,
          'Container OK',
        ],
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
          input: '{}',
        },
      );
      testOk = output.includes('Container OK');
      logger.info({ testOk }, 'Container test result');
    } catch {
      logger.error('Container test failed');
    }
  }

  const status = buildOk && testOk ? 'success' : 'failed';

  if (status === 'success') {
    persistContainerRuntime(projectRoot, runtime);
  }

  emitStatus('SETUP_CONTAINER', {
    RUNTIME: runtime,
    IMAGE: image,
    BUILD_OK: buildOk,
    TEST_OK: testOk,
    STATUS: status,
    LOG: 'logs/setup.log',
  });

  if (status === 'failed') process.exit(1);
}
