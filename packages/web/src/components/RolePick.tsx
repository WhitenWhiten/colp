import { FilterRail } from './FilterRail'

export type InviteRoleLabel = 'Editor' | 'Viewer'

const inviteRoles: InviteRoleLabel[] = ['Editor', 'Viewer']

/** Segmented Editor / Viewer control shared by collection and digest members. */
export function RolePick({
  id,
  labelledBy,
  label,
  value,
  disabled,
  onChange,
}: {
  id?: string
  labelledBy?: string
  label?: string
  value: InviteRoleLabel
  disabled?: boolean
  onChange: (role: InviteRoleLabel) => void
}) {
  return (
    <FilterRail
      className="view-switch collab-role-pick"
      variant="segments"
      selection="manual"
      label={label ?? 'Role'}
      labelledBy={labelledBy}
      testId={id}
      value={value}
      options={inviteRoles.map((role) => ({ value: role, label: role, disabled }))}
      onChange={onChange}
    />
  )
}
