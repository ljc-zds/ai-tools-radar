// Restrict the legacy storage area before any extension-side access.
(async () => {
  await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
})().catch(() => {});
