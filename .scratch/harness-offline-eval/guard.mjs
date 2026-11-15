// This evaluation permits only loopback HTTP. No real model credential is used.
import http from 'node:http';
import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
function local(input) {
  const value=input instanceof Request?input.url:input;
  const hostname=typeof value==='string'||value instanceof URL?new URL(value).hostname:(value.hostname??value.host??'localhost').split(':')[0];
  if(!['localhost','127.0.0.1','[::1]','::1'].includes(hostname))throw new Error(`Offline evaluation blocked external HTTP host: ${hostname}`);
}
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,options)=>{local(input);return originalFetch(input,options)};
for(const module of [http,https])for(const name of ['request','get']){
  const original=module[name];module[name]=function(input,...args){local(input);return original.call(this,input,...args)};
}
syncBuiltinESMExports();
