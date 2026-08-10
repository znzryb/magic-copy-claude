'use strict';

var DEFAULTS = {
  enabled: true,
  showButton: true,
  hotkey: true,
  mathStyle: 'dollar',
  bullet: '-',
  escapeText: true,
  keepLinks: true,
  keepImages: true,
  trailingSource: false
};

var BOOLS = Object.keys(DEFAULTS).filter(function (k) { return typeof DEFAULTS[k] === 'boolean'; });
var SELECTS = ['mathStyle', 'bullet'];

function el(id) { return document.getElementById(id); }

chrome.storage.sync.get(DEFAULTS, function (v) {
  BOOLS.forEach(function (k) { el(k).checked = !!v[k]; });
  SELECTS.forEach(function (k) { el(k).value = v[k]; });
});

BOOLS.concat(SELECTS).forEach(function (k) {
  el(k).addEventListener('change', function () {
    var patch = {};
    patch[k] = typeof DEFAULTS[k] === 'boolean' ? el(k).checked : el(k).value;
    chrome.storage.sync.set(patch);
  });
});
