const { ClientError, NeutralExitError, logger, tmpdir } = require("./common");
const { update } = require("./update");
const { merge } = require("./merge");

const MAX_PR_COUNT = 1000;

async function executeGitHubAction(context, eventName, eventData) {
  logger.info("Event name:", eventName);

  await checkAndAutomergeAllPullRequests(context, eventData);
}

async function checkAndAutomergeAllPullRequests(context, event) {
  const { octokit, token, config } = context;
  const repoInfo = config.repo.split('/');

  const { data: pullRequests } = await octokit.pulls.list({
    owner: repoInfo[0],
    repo: repoInfo[1],
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: MAX_PR_COUNT
  });

  for (const pullRequest of pullRequests) {
    try {
      await updateAndMergePullRequest(context, pullRequest);
    } catch (e) {
      if (e instanceof NeutralExitError) {
        logger.trace("PR update has been skipped.");
      } else {
        logger.error(e);
      }
    }
  }
}

async function updateAndMergePullRequest(context, pullRequest) {
  if (pullRequest.state !== "open") {
    logger.info("PR is not open:", pullRequest.state);
    throw new NeutralExitError();
  }

  if (skipPullRequest(context, pullRequest)) {
    throw new NeutralExitError();
  }

  const { token } = context;

  const repo = pullRequest.head.repo.full_name;
  const cloneUrl = `https://x-access-token:${token}@github.com/${repo}.git`;

  const head = await tmpdir(path =>
    update(context, path, cloneUrl, pullRequest)
  );

  await merge(context, pullRequest, head);
}

function skipPullRequest(context, pullRequest) {
  const { config } = context;

  for (const label of pullRequest.labels) {
    if (config.labels.blocking.includes(label.name)) {
      logger.info("Skipping PR, blocking label present:", label.name);
      return true;
    }
  }

  const labels = pullRequest.labels.map(label => label.name);
  for (const required of config.labels.required) {
    if (!labels.includes(required)) {
      logger.info("Skipping PR, required label missing:", required);
      return true;
    }
  }

  return false;
}

module.exports = { executeGitHubAction };
