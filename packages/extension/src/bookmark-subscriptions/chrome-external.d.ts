declare namespace chrome.runtime {
  const onMessageExternal: { addListener(callback:(message:unknown,sender:MessageSender,sendResponse:(response:unknown)=>void)=>boolean|void):void };
}
