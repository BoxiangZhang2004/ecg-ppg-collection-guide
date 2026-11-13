export const ONLINE_URL='https://boxiangzhang2004.github.io/ecg-ppg-collection-guide/?v=4.6';

export function detectSerialSupport(env=globalThis){
  if(env.location?.protocol==='file:')return {supported:false,code:'local-file',message:'请打开在线版采集网页，并使用电脑 Chrome 连接采集板。'};
  if(!env.isSecureContext)return {supported:false,code:'insecure',message:'此页面不是安全连接。请使用 HTTPS 在线版或本机 localhost 页面连接采集板。'};
  if(typeof env.navigator?.serial?.requestPort!=='function')return {supported:false,code:'unsupported',message:'当前浏览器不支持 USB 串口。真实采集请把在线版链接复制到电脑 Chrome 打开；流程演示仍可使用。'};
  try{
    const policy=env.document?.permissionsPolicy??env.document?.featurePolicy;
    if(typeof policy?.allowsFeature==='function'&&!policy.allowsFeature('serial'))return {supported:false,code:'blocked-policy',message:'当前嵌入页面未获串口权限。请在独立的电脑 Chrome 窗口打开在线版。'};
  }catch{}
  return {supported:true,code:'supported',message:''};
}

export function serialErrorMessage(error){
  if(error?.name==='NotFoundError')return '未选择串口，尚未连接。请点击“连接采集板”，在设备窗口选择采集板后点击“连接”。';
  if(['SecurityError','NotAllowedError'].includes(error?.name))return '浏览器未允许串口访问。请在独立的电脑 Chrome 窗口打开在线版，并允许连接采集板。';
  if(['NetworkError','InvalidStateError'].includes(error?.name))return '串口打开失败，可能被其他页面或程序占用。请先在 PulseScope 点击“断开连接”，并关闭旧采集程序、Arduino 串口监视器后重试。';
  return '连接失败：'+(error?.message||'未能打开串口')+'。请确认 USB 连接，并断开其他占用串口的页面或程序后重试。';
}
