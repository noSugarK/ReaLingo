import qwen from "../assets/vendors/qwen.svg";
import openai from "../assets/vendors/openai.svg";
import gemini from "../assets/vendors/gemini.svg";
import doubao from "../assets/vendors/doubao.svg";
import type { Protocol } from "../core/store";

/**
 * Each interface shown with its maker's mark, so a list of five reads at a glance.
 * SVGs from @lobehub/icons-static-svg@1.100.0 (MIT); the marks are their owners' trademarks
 * and are used only to name the service the key goes to. The Volcengine interface is the
 * Doubao model, so it carries Doubao's mark.
 *
 * `mono` marks a single-colour logo drawn in black: the dark theme inverts it (`.logo-mono`).
 */
export const VENDOR_LOGO: Record<Protocol, { src: string; mono: boolean }> = {
  qwen35: { src: qwen, mono: false },
  qwen38: { src: qwen, mono: false },
  openai: { src: openai, mono: true },
  gemini: { src: gemini, mono: false },
  volc: { src: doubao, mono: false },
};
