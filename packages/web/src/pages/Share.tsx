import { useParams, useSearchParams } from 'react-router-dom'
import { CollectionShare } from './share/CollectionShare'
import { CollectionShareEmbed } from './share/embed'
import { ProductShare } from './share/ProductShare'
// Shared with Digest routes for the embed card and appearance composer.
import '../styles/not-found.css'
import '../styles/share.css'

export { CollectionShare } from './share/CollectionShare'
export { CollectionShareEmbed } from './share/embed'
export { ProductShare } from './share/ProductShare'

export function Share() {
  const { slug } = useParams()
  const [searchParams] = useSearchParams()
  if (slug && searchParams.get('embed') === '1') {
    return <CollectionShareEmbed slug={slug} />
  }
  if (slug) {
    return <CollectionShare slug={slug} />
  }
  return <ProductShare />
}
