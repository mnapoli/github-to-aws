# Set up GitHub Actions to deploy to AWS

To deploy to AWS from GitHub Actions (using _any_ tool), you need to provide AWS credentials.

Instead of creating AWS access keys, it's simpler and more secure to use [OpenID Connect between GitHub and AWS](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services). This is a simple way to say "Repository X is allowed to deploy to AWS account Y".

Great! But setting this up is a bit of a pain.

This CLI makes it extremely easy:

```sh
npx github-to-aws --repo=your-org/your-repo
```

The command above will allow the GitHub Actions in `your-org/your-repo` to deploy to AWS in the default region.

> [!TIP]
> The CLI will ask you to confirm everything before making any changes, so feel free to run the command and see.

## How it works

The CLI will create an IAM role in your AWS account that GitHub Actions will be authorized to assume. The role will be created using CloudFormation (you can review the template in the [`cloudformation.yml` file](./cloudformation.yml)).

Note that **only** GitHub Actions from the specified repository will be able to assume this role.

## Usage in GitHub Actions

Once the CLI has created the role, it will show you the role ARN to use.

You can then use the `aws-actions/configure-aws-credentials` action to configure AWS credentials. For example:

```yaml
name: Deploy
on:
    push:
        branches: [ 'main' ]
# Necessary to deploy to AWS using OIDC
# https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services
permissions:
    id-token: write # This is required for requesting the JWT
    contents: read  # This is required for actions/checkout
jobs:
    deploy:
        runs-on: ubuntu-22.04
        concurrency: production_environment # Avoid deploying concurrently
        steps:
            -   uses: actions/checkout@v4
            # ...
            -   name: Configure AWS credentials
                uses: aws-actions/configure-aws-credentials@v4
                with:
                    # REPLACE WITH THE OUTPUT OF THE CLI
                    role-to-assume: arn:aws:iam::123456789:role/GitHubDeploymentRole
                    role-session-name: github-deployment
                    aws-region: us-east-1
            # now you can use the AWS CLI or any other tool to deploy to AWS
            # ...
```

## Options

You can specify an AWS profile and a region:

```sh
npx github-to-aws --profile=bref-cloud --region=us-east-1 --repo=your-org/your-repo
```

## Deletion

To delete the role (and the related GitHub access), delete the CloudFormation stack, for example in the AWS console.
