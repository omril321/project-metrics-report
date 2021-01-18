import os from 'os';
import path from 'path';
import fse from 'fs-extra';
import * as child_process from 'child_process';
import { processAsPromise } from '../utils';
import { CommitDetails, ProcessedProgramOptions } from '..';
import glob from 'glob';
import { CommitMetrics, CommitWithMetrics, MeasurementStrategy } from '.';
import _ from 'lodash';
import { listFilesInCommitWithPatterns } from '../gitUtils';
import globToRegex from 'glob-to-regexp';

export interface CommitSnapshot extends CommitDetails {
    cloneDestination: string;
}

export class FullSnapshotStrategy implements MeasurementStrategy {
    constructor(private options: ProcessedProgramOptions) {
    }


    public async calculateMetricsForCommits(commits: CommitDetails[]): Promise<CommitWithMetrics[]> {
        await fse.emptyDir(this.options.tmpArchivesDirectoryPath);
        return await Promise.all(commits.map((commit) => this.calculateMetricsForSingleCommit(commit)));
    }

    private async createCommitSnapshotUsingZip(commit: CommitSnapshot): Promise<void> {
        const { tmpArchivesDirectoryPath, copiedRepositoryPath } = this.options;
        try {
            await fse.emptyDir(commit.cloneDestination);
            const tmpZipPath = path.resolve(tmpArchivesDirectoryPath, `${commit.hash}.zip`);
            await processAsPromise(child_process.spawn('git', ['archive', '--format=zip', '-0', '-o', tmpZipPath, commit.hash], { cwd: copiedRepositoryPath }));

            await fse.emptyDir(commit.cloneDestination);
            await processAsPromise(child_process.spawn('unzip', ['-q', '-d', commit.cloneDestination, tmpZipPath], { cwd: tmpArchivesDirectoryPath }));
        } catch (err) {
            throw err.toString();
        }
    }

    private async createCommitSnapshotAtDestination(commit: CommitDetails): Promise<CommitSnapshot> {
        const { repositoryName } = this.options;
        const withCloneDetails = { ...commit, cloneDestination: path.resolve(os.tmpdir(), repositoryName, commit.hash) };
        await this.createCommitSnapshotUsingZip(withCloneDetails);
        return withCloneDetails;
    }

    private async getContentMetrics(existingFolderPath: string): Promise<CommitMetrics> {
        const getSingleMetricValue = async (globs: string[], phrase: string) => {
            const fileNamesToScan = _.flatten(await Promise.all(globs.map((glob => FullSnapshotStrategy.getFileNamesFromGlob(glob, existingFolderPath)))));
            const filesContainingPhrase = await Promise.all(fileNamesToScan.filter(async fileName => {
                const buffer = await fse.readFile(fileName);
                return buffer.includes(phrase);
            }));
            return filesContainingPhrase.length;
        }

        const result: CommitMetrics = {};
        const promises = _.map(this.options.trackByFileContent, async ({globs, phrase}, metricName) => {
            const metricValue = await getSingleMetricValue(globs, phrase);
            result[metricName] = metricValue;
        });
        await Promise.all(promises);

        return result;
    }

    private async getExtensionsMetrics(commit: CommitDetails) {
        const metrics: CommitMetrics = {};
        await Promise.all(Object.keys(this.options.trackByFileExtension)
            .map(async metricName => {
                const metricFilesGlobs = this.options.trackByFileExtension[metricName];
                const globsAsRegex = metricFilesGlobs.map(glob => globToRegex(glob));
                const filesInCommitWithPattern = await listFilesInCommitWithPatterns({ commitHash: commit.hash, fileRegexes: globsAsRegex, repositoryPath: this.options.copiedRepositoryPath });
                metrics[metricName] = filesInCommitWithPattern.length;
            }));

        return metrics;
    }

    private async mapCloneToMetric(clone: CommitSnapshot): Promise<CommitWithMetrics> {
        const isEmpty = fse.readdirSync(clone.cloneDestination).length === 0;
        if (isEmpty) {
            throw new Error('attempt to collect metrics for an empty directory - this probably means that the archive process malfunctioned');
        }

        const extensionsMetrics = await this.getExtensionsMetrics(clone);
        const contentMetrics = await this.getContentMetrics(clone.cloneDestination);

        return { commit: clone, metrics: { ...extensionsMetrics, ...contentMetrics } };
    }

    public async calculateMetricsForSingleCommit(commit: CommitDetails): Promise<CommitWithMetrics> {
        const commitSnapshot = await this.createCommitSnapshotAtDestination(commit);
        return this.mapCloneToMetric(commitSnapshot);
    }

    private static async getFileNamesFromGlob(globToCheck: string, folder: string): Promise<string[]> {
        return new Promise((res, rej) => {
            new glob.Glob(globToCheck, {cwd: folder, absolute: true}, (err, matches) => {
                if (err) {
                    return rej(err);
                }
                return res(matches);
            })
        })
    }
}
