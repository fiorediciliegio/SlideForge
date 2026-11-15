import { runLocalExport,type ExportTask } from "./exportTask.js";
process.on("message",async(message:ExportTask & {id:string})=>{
 process.env.SLIDEFORGE_EMBEDDED_EXPORT_ROOT=message.directory;
 try{process.send!({id:message.id,result:await runLocalExport(message)})}
 catch(error){process.send!({id:message.id,error:error instanceof Error?error.message:String(error)})}
});
