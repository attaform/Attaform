<script setup lang="ts">
  import { ref } from 'vue'
  import { useForm, useWizard, lazy } from 'attaform/zod'
  import { z } from 'zod'

  const attendee = useForm({
    schema: z.object({
      name: z.string().min(1, 'Required'),
      email: z.email('Enter a valid email'),
      role: z.enum(['attendee', 'speaker', 'sponsor']),
      partySize: z.number().int().min(1).max(20),
      region: z.enum(['us', 'eu', 'apac']),
    }),
    defaultValues: {
      name: '',
      email: '',
      role: 'attendee',
      partySize: 1,
      region: 'us',
    },
    key: 'docs-demo-slots-attendee',
  })

  const speaker = useForm({
    schema: z.object({
      talkTitle: z.string().min(3, 'At least 3 characters'),
      bio: z.string().min(20, 'At least 20 characters'),
    }),
    defaultValues: { talkTitle: '', bio: '' },
    key: 'docs-demo-slots-speaker',
  })

  const sponsor = useForm({
    schema: z.object({
      companyName: z.string().min(1, 'Required'),
      sponsorTier: z.enum(['bronze', 'silver', 'gold']),
    }),
    defaultValues: { companyName: '', sponsorTier: 'bronze' },
    key: 'docs-demo-slots-sponsor',
  })

  const companions = useForm({
    schema: z.object({
      companionsList: z.string().min(1, 'List at least one companion'),
    }),
    defaultValues: { companionsList: '' },
    key: 'docs-demo-slots-companions',
  })

  const pricingUS = useForm({
    schema: z.object({ tier: z.enum(['basic', 'pro', 'enterprise']) }),
    defaultValues: { tier: 'basic' },
    key: 'docs-demo-slots-pricing-us',
  })
  const pricingEU = useForm({
    schema: z.object({ tier: z.enum(['basic', 'pro', 'enterprise']) }),
    defaultValues: { tier: 'basic' },
    key: 'docs-demo-slots-pricing-eu',
  })
  const pricingAPAC = useForm({
    schema: z.object({ tier: z.enum(['basic', 'pro', 'enterprise']) }),
    defaultValues: { tier: 'basic' },
    key: 'docs-demo-slots-pricing-apac',
  })

  const lazyResolutions = ref(0)
  const lazyResolvedRegion = ref<string | null>(null)
  const lazyResolvedAt = ref<number | null>(null)

  const wizard = useWizard({
    steps: [
      'welcome',
      attendee,
      () =>
        attendee.values.role === 'speaker'
          ? speaker
          : attendee.values.role === 'sponsor'
            ? sponsor
            : 'no-extras',
      () => (attendee.values.partySize > 1 ? companions : undefined),
      lazy(() => {
        lazyResolutions.value += 1
        lazyResolvedRegion.value = attendee.values.region
        lazyResolvedAt.value = Date.now()
        return attendee.values.region === 'us'
          ? pricingUS
          : attendee.values.region === 'eu'
            ? pricingEU
            : pricingAPAC
      }),
      'review',
    ],
  })

  const onSubmit = wizard.handleSubmit(
    async ({ values, isFinal }) => {
      if (!isFinal) return
      await new Promise((resolve) => setTimeout(resolve, 400))
      toast.success('Registration submitted!', { description: values })
    },
    (errors) => {
      toast.error('Fix the errors above to continue.', { description: errors })
    }
  )

  function resetEverything(): void {
    wizard.reset()
    lazyResolutions.value = 0
    lazyResolvedRegion.value = null
    lazyResolvedAt.value = null
  }

  const labels: Record<string, string> = {
    welcome: 'Welcome',
    'docs-demo-slots-attendee': 'Details',
    'docs-demo-slots-speaker': 'Talk',
    'docs-demo-slots-sponsor': 'Sponsorship',
    'no-extras': 'No extras',
    'docs-demo-slots-companions': 'Companions',
    'docs-demo-slots-pricing-us': 'Pricing (US)',
    'docs-demo-slots-pricing-eu': 'Pricing (EU)',
    'docs-demo-slots-pricing-apac': 'Pricing (APAC)',
    review: 'Review',
  }

  function labelFor(key: string): string {
    return labels[key] ?? key
  }

  function formatTime(ms: number | null): string {
    if (ms === null) return '—'
    const d = new Date(ms)
    return d.toLocaleTimeString(undefined, { hour12: false })
  }
</script>

<template>
  <div class="wizard">
    <ol class="rail">
      <li
        v-for="(step, i) in wizard.steps"
        :key="step.key"
        :class="{
          done: wizard.statuses[step.key]?.valid === true && wizard.currentStep !== step.key,
          current: wizard.currentStep === step.key,
        }"
      >
        <button type="button" class="step-button" @click="wizard.goTo(step.key)">
          <span class="step-num">{{ i + 1 }}</span>
          <span class="step-label">{{ labelFor(step.key) }}</span>
        </button>
      </li>
    </ol>

    <div class="progress">
      <div class="progress-fill" :style="{ width: `${wizard.progress * 100}%` }"></div>
    </div>

    <div v-if="wizard.currentStep === 'welcome'" class="card affordance">
      <h3>Welcome aboard</h3>
      <p>
        This wizard exercises all four slot kinds: an affordance string here, a form coming up next,
        a function slot that branches by role, and a <code>lazy()</code> resolver that memoizes by
        its tracked reactive reads.
      </p>
      <p class="muted">No data is collected on this step.</p>
    </div>

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-attendee'" @submit.prevent>
      <label>
        <span>Name <span class="required" aria-hidden="true">*</span></span>
        <input v-register="attendee.register('name')" autocomplete="name" />
        <em v-if="attendee.fields.name.showErrors">{{
          attendee.fields.name.firstError?.message
        }}</em>
      </label>
      <label>
        <span>Email <span class="required" aria-hidden="true">*</span></span>
        <input v-register="attendee.register('email')" autocomplete="email" />
        <em v-if="attendee.fields.email.showErrors">{{
          attendee.fields.email.firstError?.message
        }}</em>
      </label>
      <label>
        Role
        <select v-register="attendee.register('role')">
          <option value="attendee">Attendee</option>
          <option value="speaker">Speaker</option>
          <option value="sponsor">Sponsor</option>
        </select>
      </label>
      <label>
        Party size
        <input
          v-register="attendee.register('partySize')"
          type="number"
          min="1"
          max="20"
          inputmode="numeric"
        />
      </label>
      <label>
        Region
        <select v-register="attendee.register('region')">
          <option value="us">United States</option>
          <option value="eu">Europe</option>
          <option value="apac">Asia Pacific</option>
        </select>
      </label>
    </form>

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-speaker'" @submit.prevent>
      <label>
        <span>Talk title <span class="required" aria-hidden="true">*</span></span>
        <input v-register="speaker.register('talkTitle')" />
        <em v-if="speaker.fields.talkTitle.showErrors">{{
          speaker.fields.talkTitle.firstError?.message
        }}</em>
      </label>
      <label>
        <span>Bio <span class="required" aria-hidden="true">*</span></span>
        <textarea v-register="speaker.register('bio')" rows="4"></textarea>
        <em v-if="speaker.fields.bio.showErrors">{{ speaker.fields.bio.firstError?.message }}</em>
      </label>
    </form>

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-sponsor'" @submit.prevent>
      <label>
        <span>Company name <span class="required" aria-hidden="true">*</span></span>
        <input v-register="sponsor.register('companyName')" />
        <em v-if="sponsor.fields.companyName.showErrors">{{
          sponsor.fields.companyName.firstError?.message
        }}</em>
      </label>
      <label>
        Sponsorship tier
        <select v-register="sponsor.register('sponsorTier')">
          <option value="bronze">Bronze</option>
          <option value="silver">Silver</option>
          <option value="gold">Gold</option>
        </select>
      </label>
    </form>

    <div v-else-if="wizard.currentStep === 'no-extras'" class="card affordance">
      <h3>No extras to collect</h3>
      <p>
        Attendees don't need to fill out role-specific details. This screen exists because the
        function slot returned the string <code>'no-extras'</code>; Attaform built a noop form on
        the fly under that key, no pre-declaration anywhere in <code>steps</code>.
      </p>
      <p class="muted">Switch role to <em>Speaker</em> or <em>Sponsor</em> to see the slot swap.</p>
    </div>

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-companions'" @submit.prevent>
      <label>
        <span>Companion names <span class="required" aria-hidden="true">*</span></span>
        <textarea
          v-register="companions.register('companionsList')"
          rows="3"
          placeholder="One per line"
        ></textarea>
        <em v-if="companions.fields.companionsList.showErrors">{{
          companions.fields.companionsList.firstError?.message
        }}</em>
      </label>
      <p class="muted">
        This step appears because <code>partySize &gt; 1</code>. Lower it back to 1 to see the
        function slot drop the position from <code>wizard.steps</code>.
      </p>
    </form>

    <form
      v-else-if="
        wizard.currentStep === 'docs-demo-slots-pricing-us' ||
        wizard.currentStep === 'docs-demo-slots-pricing-eu' ||
        wizard.currentStep === 'docs-demo-slots-pricing-apac'
      "
      @submit.prevent
    >
      <label>
        Tier
        <select
          v-if="wizard.currentStep === 'docs-demo-slots-pricing-us'"
          v-register="pricingUS.register('tier')"
        >
          <option value="basic">Basic</option>
          <option value="pro">Pro</option>
          <option value="enterprise">Enterprise</option>
        </select>
        <select
          v-else-if="wizard.currentStep === 'docs-demo-slots-pricing-eu'"
          v-register="pricingEU.register('tier')"
        >
          <option value="basic">Basic (incl. VAT)</option>
          <option value="pro">Pro (incl. VAT)</option>
          <option value="enterprise">Enterprise (incl. VAT)</option>
        </select>
        <select v-else v-register="pricingAPAC.register('tier')">
          <option value="basic">Basic (USD)</option>
          <option value="pro">Pro (USD)</option>
          <option value="enterprise">Enterprise (USD)</option>
        </select>
      </label>
      <div class="lazy-probe" role="status">
        <strong>Lazy probe</strong>
        <dl>
          <dt>Resolutions</dt>
          <dd>{{ lazyResolutions }}</dd>
          <dt>Resolved region</dt>
          <dd>{{ lazyResolvedRegion ?? '—' }}</dd>
          <dt>Resolved at</dt>
          <dd>{{ formatTime(lazyResolvedAt) }}</dd>
        </dl>
        <p class="muted">
          Change the region and the counter bumps because <code>lazy()</code> tracks the resolver's
          reactive reads. Toggle unrelated fields (role, party size) and it stays put. Reset clears
          every lazy cache at once.
        </p>
      </div>
    </form>

    <div v-else-if="wizard.currentStep === 'review'" class="card affordance">
      <h3>Review</h3>
      <p class="muted">Values aggregated across every step that landed in the compiled list.</p>
      <pre class="values">{{ JSON.stringify(wizard.allValues, null, 2) }}</pre>
      <div v-if="wizard.done" class="success-card" role="status">
        ✓ Registration sent. Edit any field to revise.
      </div>
    </div>

    <div class="actions">
      <button type="button" class="ghost" :disabled="!wizard.canGoBack" @click="wizard.back()">
        ← Back
      </button>
      <span class="step-of">Step {{ wizard.activeIndex + 1 }} of {{ wizard.count }}</span>
      <button
        v-if="!wizard.isFinalStep"
        type="button"
        class="primary"
        :disabled="wizard.submitting"
        @click="wizard.next()"
      >
        Next →
      </button>
      <button v-else type="button" class="primary" :disabled="wizard.submitting" @click="onSubmit">
        {{ wizard.submitting ? 'Submitting…' : 'Finish' }}
      </button>
    </div>

    <div class="reset-row">
      <button type="button" class="ghost subtle" @click="resetEverything">Reset wizard</button>
    </div>
  </div>
</template>

<style scoped>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
    max-width: 34rem;
  }
  .rail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .rail li {
    flex: 1 1 6rem;
    display: flex;
  }
  .step-button {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.5rem;
    background: #f3f4f6;
    border: 0;
    border-radius: 0.375rem;
    font-size: 0.75rem;
    font-weight: 400;
    color: #6b7280;
    cursor: pointer;
    font-family: inherit;
    text-align: left;
    transition: filter 120ms ease;
  }
  .step-button:hover {
    filter: brightness(0.95);
  }
  .step-button:focus-visible {
    outline: 2px solid #2563eb;
    outline-offset: 2px;
  }
  .rail li.current .step-button {
    background: #dbeafe;
    color: #1e40af;
    font-weight: 500;
  }
  .rail li.done .step-button {
    background: #ecfdf5;
    color: #047857;
  }
  .step-num {
    width: 1.25rem;
    height: 1.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: white;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
  }
  .progress {
    height: 0.375rem;
    border-radius: 999px;
    background: #f3f4f6;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: #2563eb;
    transition: width 200ms ease;
  }
  form {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    min-height: 12rem;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.875rem;
    font-weight: 500;
  }
  input,
  select,
  textarea {
    padding: 0.5rem 0.75rem;
    border-radius: 0.375rem;
    border: 1px solid #d1d5db;
    font-size: 0.875rem;
    font-family: inherit;
    background: white;
  }
  input:focus,
  select:focus,
  textarea:focus {
    outline: 2px solid #2563eb;
    outline-offset: -1px;
  }
  textarea {
    resize: vertical;
  }
  em {
    color: #dc2626;
    font-size: 0.8125rem;
    font-style: normal;
    font-weight: 400;
  }
  .required {
    color: #dc2626;
    font-weight: 600;
    margin-left: 0.125rem;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-height: 12rem;
    padding: 1rem;
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 0.5rem;
  }
  .card h3 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: #111827;
  }
  .card p {
    margin: 0;
    font-size: 0.875rem;
    line-height: 1.45;
    color: #374151;
  }
  .muted {
    color: #6b7280;
    font-size: 0.8125rem;
  }
  .lazy-probe {
    padding: 0.625rem 0.75rem;
    background: #fffbeb;
    border: 1px solid #fde68a;
    border-radius: 0.375rem;
    font-size: 0.8125rem;
    color: #78350f;
  }
  .lazy-probe strong {
    display: block;
    font-weight: 600;
    margin-bottom: 0.25rem;
  }
  .lazy-probe dl {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 0.5rem;
    row-gap: 0.125rem;
    margin: 0.25rem 0 0.375rem;
  }
  .lazy-probe dt {
    color: #92400e;
    font-weight: 500;
  }
  .lazy-probe dd {
    margin: 0;
    font-family: ui-monospace, monospace;
    color: #78350f;
  }
  .lazy-probe .muted {
    color: #92400e;
    margin: 0;
  }
  .values {
    margin: 0;
    padding: 0.625rem 0.75rem;
    background: white;
    border: 1px solid #e5e7eb;
    border-radius: 0.375rem;
    font-family: ui-monospace, monospace;
    font-size: 0.75rem;
    line-height: 1.4;
    max-height: 14rem;
    overflow: auto;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .step-of {
    flex: 1;
    text-align: center;
    font-size: 0.75rem;
    color: #6b7280;
    font-family: ui-monospace, monospace;
  }
  button {
    padding: 0.5rem 1rem;
    border-radius: 0.375rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    font-family: inherit;
  }
  button.primary {
    background: #2563eb;
    color: white;
    border: 1px solid #2563eb;
  }
  button.primary:hover {
    background: #1d4ed8;
  }
  button.ghost {
    background: white;
    color: #374151;
    border: 1px solid #d1d5db;
  }
  button.ghost:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  button.ghost.subtle {
    font-size: 0.75rem;
    padding: 0.25rem 0.625rem;
    color: #6b7280;
  }
  code {
    font-family: ui-monospace, monospace;
    background: #f3f4f6;
    padding: 0.05rem 0.3rem;
    border-radius: 0.25rem;
  }
  .reset-row {
    display: flex;
    justify-content: flex-end;
  }
  .success-card {
    padding: 0.625rem 0.875rem;
    border-radius: 0.375rem;
    background: #ecfdf5;
    color: #047857;
    font-size: 0.8125rem;
    font-weight: 500;
    border: 1px solid #a7f3d0;
  }
</style>
