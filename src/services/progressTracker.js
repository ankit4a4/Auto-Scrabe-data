// Simple in-memory progress tracker. This is a single-admin internal tool
// (no concurrent multi-user job queue needed), so one shared progress
// object is enough - it just reflects "the current/most recent scrape".
let progress = { current: 0, total: 0, active: false };

function startProgress(total) {
  progress = { current: 0, total, active: true };
}

function incrementProgress() {
  progress.current += 1;
}

function finishProgress() {
  progress.active = false;
}

function getProgress() {
  return { ...progress };
}

module.exports = { startProgress, incrementProgress, finishProgress, getProgress };
