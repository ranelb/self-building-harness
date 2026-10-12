/**
 * Atom registration. Importing this module installs the v0 atom set.
 *
 * Every atom is one file and one `registerAtom` call — that is the whole
 * extension point. Adding an atom must never require touching the renderer.
 */
import './button.ts'
import './column.ts'
import './input.ts'
import './markdown.ts'
import './row.ts'
import './scroll.ts'
import './select.ts'
import './text.ts'
