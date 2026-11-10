import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Tabs as TabsPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex min-w-0 gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit max-w-full items-center justify-start rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-9 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
  {
    variants: {
      variant: {
        default: "bg-muted",
        line: "h-11 w-full gap-2 rounded-none border-b bg-transparent p-0",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ref,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> &
  VariantProps<typeof tabsListVariants>) {
  const list = React.useRef<HTMLDivElement>(null)
  React.useImperativeHandle(ref, () => list.current!, [])
  React.useEffect(() => {
    const element = list.current
    if (!element) return
    const reveal = () => {
      const active = element.querySelector<HTMLElement>('[data-state="active"]')
      if (!active || element.scrollWidth <= element.clientWidth) return
      const item = active.getBoundingClientRect(), viewport = element.getBoundingClientRect()
      if (item.right > viewport.right) element.scrollLeft += item.right - viewport.right + 12
      else if (item.left < viewport.left) element.scrollLeft += item.left - viewport.left - 12
    }
    const changes = new MutationObserver(reveal)
    changes.observe(element, { subtree: true, attributes: true, attributeFilter: ['data-state'] })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal)
    resize?.observe(element)
    reveal()
    return () => { changes.disconnect(); resize?.disconnect() }
  }, [])
  return (
    <TabsPrimitive.List
      ref={list}
      data-slot="tabs-list"
      data-variant={variant}
      className={cn(tabsListVariants({ variant }), className)}
      {...props}
    />
  )
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "relative inline-flex h-full shrink-0 items-center justify-center gap-2 rounded-md border border-transparent px-3 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
        "group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start group-data-[variant=default]/tabs-list:flex-1 group-data-[variant=default]/tabs-list:data-active:bg-background group-data-[variant=default]/tabs-list:data-active:text-foreground group-data-[variant=default]/tabs-list:data-active:shadow-xs",
        "group-data-[variant=line]/tabs-list:rounded-none group-data-[variant=line]/tabs-list:data-active:text-foreground group-data-[variant=line]/tabs-list:data-active:after:bg-foreground after:absolute after:inset-x-3 after:bottom-0 after:h-0.5 after:rounded-full",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("min-w-0 flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
