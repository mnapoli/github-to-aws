#!/usr/bin/env node

import minimist from 'minimist';
import {
    CloudFormationClient,
    CreateStackCommand,
    DescribeStacksCommand,
    UpdateStackCommand,
    waitUntilStackCreateComplete,
    waitUntilStackUpdateComplete,
} from '@aws-sdk/client-cloudformation';
import ora from 'ora';
import { readFileSync } from 'fs';
import path from 'path';
import yesno from 'yesno';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { fileURLToPath } from 'url';

const options = parseOptions();

const awsOptions = {};
if (options.region) {
    awsOptions.region = options.region;
}
if (options.profile) {
    process.env.AWS_PROFILE = options.profile;
}
// The `--repo` option is required
if (!options.repo) {
    console.error('Missing the --repo option: this is the name of the GitHub repository that will be authorized to deploy to AWS (for example: --repo my-org/my-repo)');
    process.exit(1);
}
const repositoryName = options.repo;
// It must contain a slash
if (!repositoryName.includes('/')) {
    console.error('The --repo option must contain a full repository name with a slash, for example: --repo my-org/my-repo');
    process.exit(1);
}

// Generate a unique stack name that contains the normalized repository name
let stackName = 'github-deploy-' + repositoryName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
if (options.stack) {
    stackName = options.stack;
}

const accountId = await getAWSAccountId();

console.log(`The ${repositoryName} GitHub repository will be authorized to access AWS account ${accountId} in ${awsOptions.region || 'us-east-1'}.\nThis will be done by deploying an IAM role using CloudFormation (stack name: "${stackName}") using the ${process.env.AWS_PROFILE ?? 'default'} profile.\n`);
const ok = await yesno({
    question: `Do you want to continue?`,
});
if (!ok) {
    console.log('Aborted');
    process.exit(0);
}
console.log();

const cloudFormation = new CloudFormationClient(awsOptions);

let roleArn;

const spinner = ora('Deploying AWS role').start();
try {
    await deploy();
    spinner.text = 'Retrieving role ARN';
    roleArn = await getRoleArn();
} catch (e) {
    spinner.fail('Deployment failed');
    console.log();
    console.error(e);
    process.exit(1);
}
spinner.succeed('Role deployed');
console.log();
console.log(`Role ARN: ${roleArn}`);
console.log();
console.log(`You can now add these lines to your GitHub Actions file (for example .github/workflows/deploy.yml):

# ...
permissions:
    id-token: write # This is required for requesting the JWT
    contents: read  # This is required for actions/checkout
jobs:
    deploy:
        steps:
            # ...
            -   name: Configure AWS credentials
                uses: aws-actions/configure-aws-credentials@v4
                with:
                    role-to-assume: ${roleArn}
                    role-session-name: github-deploy
                    aws-region: ${awsOptions.region || 'us-east-1'}`);

async function deploy() {
    // If the CloudFormation stack already exists, update it, else create it
    let operation = UpdateStackCommand;
    let waiter = waitUntilStackUpdateComplete;
    try {
        await cloudFormation.send(new DescribeStacksCommand({
            StackName: stackName,
        }));
    } catch (e) {
        if (e.name === 'ValidationError' && e.message.includes('does not exist')) {
            // This is not an error, it just means that the stack does not exist yet
            operation = CreateStackCommand;
            waiter = waitUntilStackCreateComplete;
        } else {
            throw e;
        }
    }
    const thisDirectory = path.dirname(fileURLToPath(import.meta.url));
    try {
        await cloudFormation.send(new operation({
            StackName: stackName,
            TemplateBody: readFileSync(path.join(thisDirectory, 'cloudformation.yml'), 'utf8'),
            Capabilities: ['CAPABILITY_NAMED_IAM'],
            Parameters: [
                {
                    ParameterKey: 'FullRepoName',
                    ParameterValue: repositoryName,
                },
            ],
        }));
    } catch (e) {
        if (e.name === 'ValidationError' && e.message.includes('No updates are to be performed')) {
            // This is not an error, it just means that the stack is already up-to-date
            return;
        }
        throw e;
    }
    await waiter({
        client: cloudFormation,
    }, {
        StackName: stackName,
    });
}

async function getRoleArn() {
    const result = await cloudFormation.send(new DescribeStacksCommand({
        StackName: stackName,
    }));
    const outputs = result.Stacks[0].Outputs;
    for (const output of outputs) {
        if (output.OutputKey === 'Role') {
            return output.OutputValue;
        }
    }
    throw new Error('Could not find the role ARN in the stack outputs, did the deployment fail silently?');
}

function parseOptions() {
    const parsedArgs = minimist(process.argv.slice(2));
    /** @type {string[]} */
    const args = parsedArgs._;
    let command = args.shift();
    // Unify "no command" with "empty command"
    if (command === '') command = undefined;
    /** @type {Record<string, boolean | string | string[]>} */
    const options = parsedArgs;
    delete options._;
    return options;
}

async function getAWSAccountId() {
    const response = await new STSClient(awsOptions).send(
        new GetCallerIdentityCommand({}),
    );
    return response.Account;
}
