// A classic script runs even when index.html was opened with file://.
// Local ES-module imports cannot start there; move to the same public app.
(() => {
  const onlineURL='https://boxiangzhang2004.github.io/ecg-ppg-collection-guide/?v=4.5';
  const warning=document.getElementById('startup-warning');
  const message=document.getElementById('startup-message');
  if(location.protocol==='file:'){
    warning.hidden=false;
    message.textContent='本地文件无法启动采集工具，正在打开在线版。若未自动打开，请点击右侧链接。';
    try{location.replace(onlineURL);}catch{}
    return;
  }
  import('./app.mjs?v=4.5').then(()=>{warning.hidden=true;}).catch(error=>{
    warning.hidden=false;
    message.textContent='网页未能启动。请重新加载，或打开在线版；已有本机采集记录不会被清除。';
    console.error('Acquisition page startup failed',error);
  });
})();
