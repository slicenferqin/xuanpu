import { describe, expect, it, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '../utils/render'
import { ProjectAvatar } from '../../src/renderer/src/components/projects/ProjectAvatar'
import { FilterChips } from '../../src/renderer/src/components/projects/FilterChips'
import { resetProjectIconCacheForTests } from '../../src/renderer/src/components/projects/project-icon-utils'

const mockProjectOps = {
  loadLanguageIcons: vi.fn().mockResolvedValue({}),
  getProjectIconPath: vi.fn().mockResolvedValue(null)
}

Object.defineProperty(window, 'projectOps', {
  writable: true,
  value: {
    ...(window.projectOps ?? {}),
    ...mockProjectOps
  }
})

describe('ProjectAvatar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetProjectIconCacheForTests()
    mockProjectOps.loadLanguageIcons.mockResolvedValue({})
    mockProjectOps.getProjectIconPath.mockResolvedValue(null)
  })

  it('renders initials for a project name by default', () => {
    render(<ProjectAvatar name="internal-starlight-base" />)

    expect(screen.getByTestId('project-avatar')).toHaveTextContent('IB')
  })

  it('prefers a custom project image over initials', async () => {
    mockProjectOps.getProjectIconPath.mockResolvedValue('data:image/png;base64,ZmFrZQ==')

    render(<ProjectAvatar name="xuanpu" customIcon="xuanpu.png" />)

    expect(await screen.findByRole('img', { name: 'project icon' })).toBeInTheDocument()
    expect(screen.queryByText('XU')).not.toBeInTheDocument()
  })

  it('does not affect language filter chips', async () => {
    render(<FilterChips languages={['typescript']} onRemove={vi.fn()} />)

    await waitFor(() => {
      expect(mockProjectOps.loadLanguageIcons).toHaveBeenCalled()
    })

    expect(screen.getByText('TS')).toBeInTheDocument()
    expect(screen.queryByTestId('project-avatar')).not.toBeInTheDocument()
  })
})
