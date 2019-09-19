const { logger, NeutralExitError } = require("./common");
const git = require("./git");

const FETCH_TIMEOUT = 60000;
const BLOCKED_STATE = "blocked";
const AUTOMERGE_LABEL_DROPPED = 'Automerge label was dropped and added again due to the fact that either someone requested changes' +
                                ', you do not have a review, or someone who reviewed and approved your pr left comments. ';

async function update(context, dir, url, pullRequest) {
  logger.info(`Updating PR #${pullRequest.number} ${pullRequest.title}`);

  if (pullRequest.merged === true) {
    logger.info("PR is already merged!");
    throw new NeutralExitError();
  }

  if (pullRequest.head.repo.full_name !== pullRequest.base.repo.full_name) {
    logger.info("PR branch is from external repository, skipping");
    throw new NeutralExitError();
  }

  const { octokit, config } = context;
  const { automerge, autorebase } = config;
  const actions = [automerge, autorebase];

  let action = null;
  let skipAdvancedApprovalValidation = false;
  for (const label of pullRequest.labels) {
    if (actions.includes(label.name)) {
      if (action === null) {
        action = label.name;
      } else {
        throw new Error(`ambiguous labels: ${action} + ${label.name}`);
      }
    }

    if (label.name == config.skipAdvancedApprovalValidation) {
      skipAdvancedApprovalValidation = true;
    }
  }

  if (action === null) {
    logger.info("No matching labels found on PR, skipping");
    throw new NeutralExitError();
  }

  if (!skipAdvancedApprovalValidation) {
    let isReviewedCorrectly = await isPrReviewed(octokit, pullRequest, actions);
    if (!isReviewedCorrectly) {
      logger.info("Pr review state is unstable (changes requested after labelling)")
      await dropAutoMergeLabel(octokit, pullRequest, actions);
      throw new NeutralExitError();
    } else {
      logger.info("Pr review is correct (no changes requested after labelling)")
    }
  
    if (!octokit || !dir || !url) {
      throw new Error("invalid arguments!");
    }
  }

  if (action === automerge) {
    return await merge(octokit, pullRequest);
  } else if (action === autorebase) {
    return await rebase(dir, url, pullRequest);
  } else {
    throw new Error(`invalid action: ${action}`);
  }
}

async function dropAutoMergeLabel(octokit, pullRequest, actions) {
  let labels = [];

  for (const label of pullRequest.labels) {
    if (!actions.includes(label.name)) {
      labels.push(label.name);
    }
  }

  logger.info("Dropping automerge label");

  const { data: patched } = await octokit.issues.update({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    issue_number: pullRequest.number,
    labels: labels
  })

  logger.info("Adding comment about dropping automerge label");

  const { data: comment } = await octokit.issues.createComment({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    issue_number: pullRequest.number,
    body: AUTOMERGE_LABEL_DROPPED
  })

  logger.info("Adding automerge label again");
}

async function isPrReviewed(octokit, pullRequest, actions) {
  let needsChangesAfterLabeled = false;

  const { data: reviews } = await octokit.pulls.listReviews({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    pull_number: pullRequest.number
  })

  const { data: events } = await octokit.issues.listEvents({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    issue_number: pullRequest.number
  })

  events.reverse();
  reviews.reverse();

  let lastLabeledDate;
  for (const event of events) {
    if (event.event == "labeled" && actions.includes(event.label.name)) {
      lastLabeledDate = new Date(event.created_at);
      break;
    }
  }

  for (const review of reviews) {
    if ((new Date(review.submitted_at)) < lastLabeledDate) {
      break;
    }

    if (review.state == "CHANGES_REQUESTED" || review.state == "APPROVED") {
      const { data: comments } = await octokit.pulls.getCommentsForReview({
        owner: pullRequest.head.repo.owner.login,
        repo: pullRequest.head.repo.name,
        pull_number: pullRequest.number,
        review_id: review.id
      })

      needsChangesAfterLabeled = (needsChangesAfterLabeled || (comments && comments.length));
    } else {
      needsChangesAfterLabeled = true;
    }
  }

  return !needsChangesAfterLabeled;
}

async function merge(octokit, pullRequest) {
  const state = await pullRequestState(octokit, pullRequest);
  if (state === "behind") {
    const headRef = pullRequest.head.ref;
    const baseRef = pullRequest.base.ref;

    logger.debug("Merging latest changes from", baseRef, "into", headRef);
    const { status, data } = await octokit.repos.merge({
      owner: pullRequest.head.repo.owner.login,
      repo: pullRequest.head.repo.name,
      base: headRef,
      head: baseRef
    });

    logger.trace("Merge result:", status, data);

    if (status === 204) {
      logger.info("No merge performed, branch is up to date!");
      return pullRequest.head.sha;
    } else {
      logger.info("Merge succeeded, new HEAD:", headRef, data.sha);
      await new Promise(resolve => setTimeout(() => resolve(), 30000));
      return data.sha;
    }
  } else if (state === "clean" || state === "has_hooks") {
    logger.info("No update necessary");
    return pullRequest.head.sha;
  } else {
    logger.info("No update done due to PR state", state);
    throw new NeutralExitError();
  }
}

async function pullRequestState(octokit, pullRequest) {
  const { data: fullPullRequest } = await octokit.pulls.get({
    owner: pullRequest.head.repo.owner.login,
    repo: pullRequest.head.repo.name,
    pull_number: pullRequest.number
  });

  return fullPullRequest.mergeable_state;
}

async function rebase(dir, url, pullRequest) {
  const headRef = pullRequest.head.ref;
  const baseRef = pullRequest.base.ref;

  logger.debug("Cloning into", dir, `(${headRef})`);
  await git.clone(url, dir, headRef);

  logger.debug("Fetching", baseRef, "...");
  await git.fetch(dir, baseRef);
  await git.fetchUntilMergeBase(dir, baseRef, FETCH_TIMEOUT);

  const head = await git.head(dir);
  if (head !== pullRequest.head.sha) {
    logger.info(`HEAD changed to ${head}, skipping`);
    throw new NeutralExitError();
  }

  logger.info(headRef, "HEAD:", head);

  const onto = await git.sha(dir, baseRef);

  logger.info("Rebasing onto", baseRef, onto);
  await git.rebase(dir, onto);

  const newHead = await git.head(dir);
  if (newHead === head) {
    logger.info("Already up to date:", headRef, "->", baseRef, onto);
  } else {
    logger.debug("Pushing changes...");
    await git.push(dir, true, headRef);
    await new Promise(resolve => setTimeout(() => resolve(), 30000));

    logger.info("Updated:", headRef, head, "->", newHead);
  }

  return newHead;
}

module.exports = { update };
