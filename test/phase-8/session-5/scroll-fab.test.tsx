import { describe, test, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ScrollToBottomFab } from '../../../src/renderer/src/components/sessions/ScrollToBottomFab'

/**
 * Session 5: ScrollToBottomFab Component
 *
 * These tests verify the ScrollToBottomFab component:
 * - Renders with an ArrowDown icon and correct aria-label
 * - Visible/hidden states controlled by the `visible` prop
 * - Calls onClick when clicked while visible
 * - Not clickable when hidden (pointer-events-none)
 * - Positioned absolutely for fixed viewport placement
 *
 * Also verifies ScrollToBottomFab.tsx source structure.
 */

describe('Session 5: ScrollToBottomFab', () => {
  describe('ScrollToBottomFab component', () => {
    test('renders with ArrowDown icon and aria-label', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button).toBeDefined()
      expect(button.getAttribute('aria-label')).toBe('Scroll to bottom')

      // Verify the SVG icon is rendered (lucide-react ArrowDown)
      const svg = button.querySelector('svg')
      expect(svg).not.toBeNull()
    })

    test('visible when visible=true', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('opacity-100')
      expect(button.className).not.toContain('pointer-events-none')
    })

    test('hidden when visible=false', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={false} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('opacity-0')
      expect(button.className).toContain('pointer-events-none')
    })

    test('calls onClick when clicked', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      fireEvent.click(button)
      expect(onClick).toHaveBeenCalledTimes(1)
    })

    test('has translate-y-0 when visible', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('translate-y-0')
    })

    test('has translate-y-2 when hidden (slide-up animation)', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={false} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('translate-y-2')
    })

    test('has transition-all duration-200 for smooth animation', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('transition-all')
      expect(button.className).toContain('duration-200')
    })

    test('has absolute positioning classes', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('absolute')
      expect(button.className).toContain('bottom-4')
      expect(button.className).toContain('right-4')
      expect(button.className).toContain('z-10')
    })

    test('has backdrop blur and border styling', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('backdrop-blur-sm')
      expect(button.className).toContain('border')
      expect(button.className).toContain('rounded-full')
      expect(button.className).toContain('shadow-md')
    })

    test('renders unread count as a pill when count is provided', () => {
      const onClick = vi.fn()
      render(<ScrollToBottomFab onClick={onClick} visible={true} count={12} />)

      const button = screen.getByTestId('scroll-to-bottom-fab')
      expect(button.className).toContain('min-w-[3.25rem]')
      expect(screen.getByTestId('scroll-to-bottom-fab-count')).toHaveTextContent('12')
    })
  })

  describe('ScrollToBottomFab.tsx source verification', () => {
    test('component file exists and has correct structure', async () => {
      const fs = await import('fs')
      const path = await import('path')
      const sourcePath = path.resolve(
        __dirname,
        '../../../src/renderer/src/components/sessions/ScrollToBottomFab.tsx'
      )
      const source = fs.readFileSync(sourcePath, 'utf-8')

      // Imports
      expect(source).toContain("import { ArrowDown } from 'lucide-react'")
      expect(source).toContain("import { cn } from '@/lib/utils'")

      // Props interface
      expect(source).toContain('interface ScrollToBottomFabProps')
      expect(source).toContain('onClick: () => void')
      expect(source).toContain('visible: boolean')

      // Export
      expect(source).toContain('export function ScrollToBottomFab')

      // Accessibility
      expect(source).toContain("aria-label={t('scrollToBottomFab.ariaLabel')}")
      expect(source).toContain('data-testid="scroll-to-bottom-fab"')

      // Conditional classes
      expect(source).toContain('opacity-100')
      expect(source).toContain('opacity-0')
      expect(source).toContain('pointer-events-none')
      expect(source).toContain('translate-y-0')
      expect(source).toContain('translate-y-2')
      expect(source).toContain('scroll-to-bottom-fab-count')
    })
  })
})
