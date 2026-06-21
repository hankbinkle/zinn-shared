// =============================================================================
// railway.js -- Shared Railway GraphQL module for ZINN services
// Query Railway API for workspaces, projects, services, and env var names.
// Registered with shared_resource_manager.
//
// Usage:
//   const railway = require('../_shared/railway');
//   const workspaces = await railway.listWorkspaces();
//   const projects = await railway.listProjects(workspaceId);
//   const vars = await railway.getVariables(envId);
// =============================================================================
'use strict';

const https = require('https');

// -------------------------------------------------------------------------
// Constants
// -------------------------------------------------------------------------

const API_ENDPOINT = 'https://backboard.railway.app/graphql/v2';
const VERSION = '1.0.0';

function getToken() {
  const token = process.env.RAILWAY_API_TOKEN || '';
  if (!token) {
    throw new Error(
      'RAILWAY_API_TOKEN not set. ' +
      'Export it or set in Railway env vars.'
    );
  }
  return token;
}

// -------------------------------------------------------------------------
// Low-Level GraphQL POST
// -------------------------------------------------------------------------

function graphql(query, variables) {
  return new Promise(function(resolve, reject) {
    const body = JSON.stringify({
      query: query,
      variables: variables || {},
    });

    const u = new URL(API_ENDPOINT);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getToken(),
      },
    }, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        if (res.statusCode !== 200) {
          reject(new Error('Railway HTTP ' + res.statusCode + ': ' + data.slice(0, 300)));
          return;
        }
        try {
          const parsed = JSON.parse(data);
          if (parsed.errors) {
            reject(new Error('Railway GraphQL: ' + JSON.stringify(parsed.errors)));
            return;
          }
          resolve(parsed.data);
        } catch (e) {
          reject(new Error('Railway JSON parse: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// -------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------

/**
 * List all workspaces accessible to the authenticated user.
 * @returns {Promise<Array>} Array of { id, name }
 */
async function listWorkspaces() {
  console.log('[shared/railway] Listing workspaces...');
  const data = await graphql(`
    query GetWorkspaces {
      me {
        workspaces {
          id
          name
        }
      }
    }
  `);
  return data.me.workspaces;
}

/**
 * List all Railway projects with their services and environments.
 * Requires a workspace ID (get from listWorkspaces()).
 * @param {string} workspaceId - Railway workspace UUID
 * @returns {Promise<Array>} Array of project objects
 */
async function listProjects(workspaceId) {
  if (!workspaceId) {
    throw new Error('workspaceId required. Call listWorkspaces() first.');
  }
  console.log('[shared/railway] Listing projects in workspace ' + workspaceId + '...');
  const data = await graphql(`
    query GetProjects($wsId: String!) {
      workspace(workspaceId: $wsId) {
        id
        name
        projects {
          edges {
            node {
              id
              name
              createdAt
              updatedAt
              deletedAt
              environments {
                edges {
                  node {
                    id
                    name
                    canAccess
                  }
                }
              }
              services {
                edges {
                  node {
                    id
                    name
                  }
                }
              }
            }
          }
        }
      }
    }
  `, { wsId: workspaceId });
  return data.workspace.projects.edges.map(function(e) { return e.node; });
}

/**
 * Get a single Railway project by ID.
 * @param {string} projectId - Railway project UUID
 * @returns {Promise<Object>} Project object
 */
async function getProject(projectId) {
  console.log('[shared/railway] Getting project ' + projectId + '...');
  const data = await graphql(`
    query GetProject($id: String!) {
      project(id: $id) {
        id
        name
        createdAt
        updatedAt
        deletedAt
        environments {
          edges {
            node {
              id
              name
              canAccess
            }
          }
        }
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `, { id: projectId });
  return data.project;
}

/**
 * Get a single Railway service by ID.
 * @param {string} serviceId - Railway service UUID
 * @returns {Promise<Object>} Service object
 */
async function getService(serviceId) {
  console.log('[shared/railway] Getting service ' + serviceId + '...');
  const data = await graphql(`
    query GetService($id: String!) {
      service(id: $id) {
        id
        name
        createdAt
        updatedAt
        deletedAt
      }
    }
  `, { id: serviceId });
  return data.service;
}

/**
 * Get environment variable names for a given environment ID.
 * NOTE: Railway API only returns variable NAMES, not values (security).
 * @param {string} environmentId - Railway environment UUID
 * @returns {Promise<Array<string>>} Array of variable names
 */
async function getVariables(environmentId) {
  console.log('[shared/railway] Getting variable names for env ' + environmentId + '...');
  const data = await graphql(`
    query GetVariables($id: String!) {
      environment(id: $id) {
        id
        name
        variables {
          edges {
            node {
              name
            }
          }
        }
      }
    }
  `, { id: environmentId });

  var envData = data.environment;
  var names = (envData.variables.edges || []).map(function(e) {
    return e.node.name;
  });
  return names;
}

module.exports = {
  listWorkspaces: listWorkspaces,
  listProjects: listProjects,
  getProject: getProject,
  getService: getService,
  getVariables: getVariables,
  VERSION: VERSION,
};
