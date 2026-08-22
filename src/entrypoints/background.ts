import { browser } from "wxt/browser";

export default defineBackground(() => {
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
