import * as THREE from 'three';

declare global {
  interface Window {
    THREE?: unknown;
  }
}

if (!window.THREE) {
  window.THREE = { ...THREE };
}

export {};
