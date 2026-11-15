export default async function* report(source) {
  for await(const event of source) {
    if(['test:pass','test:fail'].includes(event.type))yield JSON.stringify({type:event.type,name:event.data.name,file:event.data.file,ms:event.data.details?.duration_ms,error:event.type==='test:fail'?String(event.data.details?.error):undefined})+'\n';
    else if(['test:stdout','test:stderr'].includes(event.type))yield JSON.stringify({type:event.type,message:event.data.message})+'\n';
  }
}
