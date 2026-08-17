import {
  callTool,
  loadCredentials,
  safeErrorMessage,
} from '../../plugins/ergouzi-media-mcp/scripts/lib.mjs';

let credentials;
try {
  credentials = await loadCredentials();
  const models = await callTool('list_models', {}, credentials);
  const results = Array.isArray(models)
    ? models
    : Array.isArray(models?.results)
      ? models.results
      : [];
  console.log(
    JSON.stringify(
      {
        base_url: credentials.baseUrl,
        visible_model_count: results.length,
        models: results.map(({ owner, name }) => ({ owner, name })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(safeErrorMessage(error, credentials));
  process.exitCode = 1;
}
