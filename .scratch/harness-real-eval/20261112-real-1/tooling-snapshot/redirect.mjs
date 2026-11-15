// Evaluation only: keep the production endpoint identity (including image-token estimates).
const original = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (new URL(url).hostname === 'api.deepseek.com') {
    if (!process.env.SF_EVAL_PROXY) throw new Error('Missing evaluation proxy');
    return original(process.env.SF_EVAL_PROXY + new URL(url).pathname, options);
  }
  return original(input, options);
};
