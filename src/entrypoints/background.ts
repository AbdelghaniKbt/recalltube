import { browser } from "wxt/browser";
import { registerPlaylistCoordinator } from "../playlist/coordinator";

export default defineBackground(() => {
  registerPlaylistCoordinator();
  browser.runtime.onInstalled.addListener(() => {
    void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  });

  void browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
