"use strict";

/**
 * The issue's status on the org project in `project:` (feedback.yml): backlog while it waits for
 * an answer, agent once route:agent is set, review once the agent's PR is open, dev once a
 * developer has it. Needs the App's organization Projects: read and write permission.
 */

const FIELD_QUERY = `
  query ($owner: String!, $number: Int!, $field: String!) {
    organization(login: $owner) {
      projectV2(number: $number) {
        id
        field(name: $field) {
          ... on ProjectV2SingleSelectField { id options { id name } }
        }
      }
    }
  }`;

const ADD_ITEM = `
  mutation ($projectId: ID!, $contentId: ID!) {
    addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
  }`;

const SET_STATUS = `
  mutation ($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
    updateProjectV2ItemFieldValue(
      input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }
    ) { projectV2Item { id } }
  }`;

/**
 * Add the issue to the project (a no-op if it's there) and set its status. Never throws: a board
 * problem is logged, and the triage or handoff carries on.
 * @returns {Promise<string | null>} the status set, or null
 */
async function setProjectStatus({ github, owner, issue, config, key, log = () => {} }) {
  const project = config.project;
  if (!project) return null;
  const status = project.statuses[key];
  try {
    const data = await github.graphql(FIELD_QUERY, { owner, number: project.number, field: project.field });
    const board = data?.organization?.projectV2;
    if (!board) throw new Error(`no project #${project.number} in ${owner}`);
    if (!board.field?.options) throw new Error(`no single-select field "${project.field}"`);
    const option = board.field.options.find((o) => o.name.toLowerCase() === status.toLowerCase());
    if (!option) throw new Error(`"${project.field}" has no "${status}" option`);

    const added = await github.graphql(ADD_ITEM, { projectId: board.id, contentId: issue.node_id });
    await github.graphql(SET_STATUS, {
      projectId: board.id,
      itemId: added.addProjectV2ItemById.item.id,
      fieldId: board.field.id,
      optionId: option.id,
    });
    return option.name;
  } catch (error) {
    log(`Could not set ${project.field} to "${status}" on project #${project.number}: ${error.message}`);
    return null;
  }
}

module.exports = { setProjectStatus };
