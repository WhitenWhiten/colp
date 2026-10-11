import { Link } from 'react-router-dom'

/** COLP Server mark (public/colp-mark.svg), also the self-hosted favicon. */
function ColpMark() {
  return (
    <img
      className="brand-glyph"
      src="/colp-mark.svg"
      alt=""
      width={28}
      height={28}
      draggable={false}
      aria-hidden="true"
    />
  )
}

export function BrandName() {
  return (
    <span className="brand-name">
      <ColpMark />
      <span>COLP <span className="brand-name-sub">Server</span></span>
    </span>
  )
}

export function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="brand" aria-label="COLP Server home">
      <BrandName />
    </Link>
  )
}
