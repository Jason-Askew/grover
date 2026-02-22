const fs = require('fs');
const path = require('path');

function findFiles(dir, extension) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      files.push(...findFiles(fullPath, extension));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(extension)) {
      files.push(fullPath);
    }
  }
  return files;
}

const findPdfs = (dir) => findFiles(dir, '.pdf');
const findMarkdownFiles = (dir) => findFiles(dir, '.md');

module.exports = { findFiles, findPdfs, findMarkdownFiles };
