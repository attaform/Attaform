import PrimeVue from 'primevue/config'
import Aura from '@primeuix/themes/aura'

// PrimeVue is wired up ONLY to power the third-party-component gallery in the
// docs (ThirdPartyGallery.vue), which shows `v-register` binding to a real
// batteries-included component kit. It is deliberately NOT part of the site's
// own UI surface; the site chrome stays hand-rolled reka-ui + Tailwind.
//
// Containment: PrimeVue's styled-mode CSS only ever targets `.p-*` selectors
// plus `:root` design tokens, so it cannot restyle the site's own elements.
// On top of that, `cssLayer` parks all of it in an `@layer primevue` that sits
// below the site's unlayered styles in the cascade (the matching `@layer`
// order is declared at the top of `assets/css/tailwind.css`), so even a future
// selector collision loses to the site. Universal (not `.client`) so the
// gallery renders during SSR / prerender, matching the inline-demo contract.
export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.use(PrimeVue, {
    theme: {
      preset: Aura,
      options: {
        darkModeSelector: '.dark',
        cssLayer: { name: 'primevue', order: 'theme, base, primevue, components, utilities' },
      },
    },
  })
})
