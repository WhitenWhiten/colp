import { Link } from 'react-router-dom'
import { isSelfHostedEdition } from '../lib/edition'

/* BrandMark uses the v2 N icon; BrandName uses the complete v2 vector wordmark. */

export function BrandMark({ className }: { className?: string }) {
  return (
    <img
      className={['brand-mark', className].filter(Boolean).join(' ')}
      src="/favicon.svg"
      alt=""
      width={32}
      height={32}
      draggable={false}
      aria-hidden="true"
    />
  )
}

export function BrandName() {
  if (isSelfHostedEdition()) {
    return <span className="brand-name">COLP</span>
  }
  return (
    // R15-39: the name lives on the image (alt), not an aria-label on a span.
    <span className="brand-name">
      <img className="brand-wordmark" src="/brand-wordmark.svg" alt="Know-N" width={438} height={128} draggable={false} />
    </span>
  )
}

export function Brand({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="brand" aria-label={isSelfHostedEdition() ? 'COLP home' : 'Know-N home'}>
      <BrandName />
    </Link>
  )
}
