import assert from "node:assert/strict";
import test from "node:test";
import {publishRemoteFile} from "../../src/server/fileClient.js";
test("remote file publish rejects missing ownership before reading or uploading",async()=>{
 await assert.rejects(()=>publishRemoteFile({filePath:"/does/not/exist",deckId:"deck-a",format:"pptx"}),/文件归属/);
});
