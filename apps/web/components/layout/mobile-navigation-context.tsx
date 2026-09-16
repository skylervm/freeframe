'use client'

import * as React from 'react'

interface MobileNavigationContextValue {
  isOpen: boolean
  toggle: (trigger?: HTMLElement) => void
}

const MobileNavigationContext = React.createContext<MobileNavigationContextValue | null>(null)

export function MobileNavigationProvider({
  isOpen,
  onToggle,
  children,
}: {
  isOpen: boolean
  onToggle: (trigger?: HTMLElement) => void
  children: React.ReactNode
}) {
  return (
    <MobileNavigationContext.Provider value={{ isOpen, toggle: onToggle }}>
      {children}
    </MobileNavigationContext.Provider>
  )
}

export function useMobileNavigation() {
  const navigation = React.useContext(MobileNavigationContext)
  if (!navigation) {
    throw new Error('useMobileNavigation must be used inside MobileNavigationProvider')
  }
  return navigation
}
