'use strict';

const MINIMUM_NODE_MAJOR = 24;

function checkNodeVersion(version = process.versions.node) {
  const normalized = String(version).replace(/^v/, '');
  const major = Number.parseInt(normalized.split('.')[0] || '', 10);
  const supported = Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR;
  return {
    supported,
    version: normalized,
    major: Number.isInteger(major) ? major : null,
    message: supported
      ? `Node v${normalized} is supported (Node ${MINIMUM_NODE_MAJOR} or newer).`
      : `Upgrade Node from v${normalized} to Node ${MINIMUM_NODE_MAJOR} or newer. The plugin runs its TypeScript sources through Node type stripping, so older Node majors cannot load them.`,
  };
}

module.exports = { MINIMUM_NODE_MAJOR, checkNodeVersion };
