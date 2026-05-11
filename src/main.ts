import * as fs from 'fs';
import * as path from 'path';
import yargs from 'yargs';
import type {Arguments} from 'yargs';
import * as context from './context';
import * as goreleaser from './goreleaser';
import {getRequestedVersion} from './version';
import * as core from '@actions/core';
import * as exec from '@actions/exec';
import axios, {isAxiosError} from 'axios';

async function validateSubscription(): Promise<void> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  let repoPrivate: boolean | undefined;

  if (eventPath && fs.existsSync(eventPath)) {
    const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
    repoPrivate = eventData?.repository?.private;
  }

  const upstream = 'goreleaser/goreleaser-action';
  const action = process.env.GITHUB_ACTION_REPOSITORY;
  const docsUrl = 'https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions';

  core.info('');
  core.info('[1;36mStepSecurity Maintained Action[0m');
  core.info(`Secure drop-in replacement for ${upstream}`);
  if (repoPrivate === false) core.info('[32m✓ Free for public repositories[0m');
  core.info(`[36mLearn more:[0m ${docsUrl}`);
  core.info('');

  if (repoPrivate === false) return;

  const serverUrl = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const body: Record<string, string> = {action: action || ''};
  if (serverUrl !== 'https://github.com') body.ghes_server = serverUrl;
  try {
    await axios.post(
      `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
      body,
      {timeout: 3000}
    );
  } catch (error) {
    if (isAxiosError(error) && error.response?.status === 403) {
      core.error(`[1;31mThis action requires a StepSecurity subscription for private repositories.[0m`);
      core.error(`[31mLearn how to enable a subscription: ${docsUrl}[0m`);
      process.exit(1);
    }
    core.info('Timeout or API not reachable. Continuing to next step.');
  }
}

async function run(): Promise<void> {
  try {
    await validateSubscription();
    const inputs: context.Inputs = await context.getInputs();
    const version = getRequestedVersion(inputs);
    const bin = await goreleaser.install(inputs.distribution, version);
    core.info(`GoReleaser ${version} installed successfully`);

    if (inputs.installOnly) {
      const goreleaserDir = path.dirname(bin);
      core.addPath(goreleaserDir);
      core.debug(`Added ${goreleaserDir} to PATH`);
      return;
    } else if (!inputs.args) {
      core.setFailed('args input required');
      return;
    }

    if (inputs.workdir && inputs.workdir !== '.') {
      core.info(`Using ${inputs.workdir} as working directory`);
      process.chdir(inputs.workdir);
    }

    let yamlfile: string | unknown;
    const argv: Arguments<{config?: string}> = yargs(inputs.args).parseSync() as Arguments<{
      config?: string;
    }>;
    if (argv.config) {
      yamlfile = argv.config;
    } else {
      [
        '.config/goreleaser.yaml',
        '.config/goreleaser.yml',
        '.goreleaser.yaml',
        '.goreleaser.yml',
        'goreleaser.yaml',
        'goreleaser.yml'
      ].forEach(f => {
        if (fs.existsSync(f)) {
          yamlfile = f;
        }
      });
    }

    await exec.exec(`${bin} ${inputs.args}`);

    if (typeof yamlfile === 'string') {
      const artifacts = await goreleaser.getArtifacts(await goreleaser.getDistPath(yamlfile));
      if (artifacts) {
        await core.group(`Artifacts output`, async () => {
          core.info(artifacts);
          core.setOutput('artifacts', artifacts);
        });
      }
      const metadata = await goreleaser.getMetadata(await goreleaser.getDistPath(yamlfile));
      if (metadata) {
        await core.group(`Metadata output`, async () => {
          core.info(metadata);
          core.setOutput('metadata', metadata);
        });
      }
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();
