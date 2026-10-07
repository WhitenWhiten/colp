import { FilterRail } from './FilterRail'
import { useUiDensity } from '../lib/useUiDensity'

export function DensitySwitch() {
  const [density, setDensity] = useUiDensity()
  return (
    <FilterRail
      className="view-switch"
      variant="segments"
      label="Density"
      value={density}
      options={[
        { value: 'comfortable' as const, label: 'Comfort' },
        { value: 'compact' as const, label: 'Compact' },
      ]}
      onChange={setDensity}
    />
  )
}
