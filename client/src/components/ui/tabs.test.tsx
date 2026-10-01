import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs.js'

describe('Tabs', () => {
  it('switches the active tab on programmatic fireEvent.click() and element.click()', () => {
    render(
      <Tabs defaultValue="tab1">
        <TabsList>
          <TabsTrigger value="tab1">Tab 1</TabsTrigger>
          <TabsTrigger value="tab2">Tab 2</TabsTrigger>
          <TabsTrigger value="tab3">Tab 3</TabsTrigger>
        </TabsList>
        <TabsContent value="tab1">Content 1</TabsContent>
        <TabsContent value="tab2">Content 2</TabsContent>
        <TabsContent value="tab3">Content 3</TabsContent>
      </Tabs>,
    )

    const tab1 = screen.getByRole('tab', { name: 'Tab 1' })
    const tab2 = screen.getByRole('tab', { name: 'Tab 2' })
    const tab3 = screen.getByRole('tab', { name: 'Tab 3' })

    expect(tab1).toHaveAttribute('data-state', 'active')
    expect(tab2).toHaveAttribute('data-state', 'inactive')
    expect(screen.getByText('Content 1')).toBeInTheDocument()

    fireEvent.click(tab2)

    expect(tab1).toHaveAttribute('data-state', 'inactive')
    expect(tab2).toHaveAttribute('data-state', 'active')
    expect(screen.getByText('Content 2')).toBeInTheDocument()

    fireEvent.click(tab3)

    expect(tab3).toHaveAttribute('data-state', 'active')
    expect(tab2).toHaveAttribute('data-state', 'inactive')
    expect(screen.getByText('Content 3')).toBeInTheDocument()
  })
})
