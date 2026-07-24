// ********* UTILS/NORMALISE.JS *********
'use strict';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

module.exports = {
  asArray,
  cleanString,
  unique,
};
