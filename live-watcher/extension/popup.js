async function render() {
  const {health = {status: 'not_started'}} = await chrome.storage.local.get('health');
  document.querySelector('#status').textContent = health.status;
  document.querySelector('#details').textContent = JSON.stringify(health, null, 2);
}
for (const command of ['start', 'stop']) document.querySelector('#' + command).onclick = async () => {
  await chrome.runtime.sendMessage({type: command}); await render();
};
chrome.storage.onChanged.addListener(render);
render();
