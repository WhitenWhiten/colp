/**
 * Product library desk: `/library` and `/library/:id`.
 */
import { LibraryDesk } from './library-desk/LibraryDesk'
// Shared product-loop stylesheet (see main.tsx); ships with this route chunk.
import '../styles/library.css'

export function Library() {
  return <LibraryDesk />
}
