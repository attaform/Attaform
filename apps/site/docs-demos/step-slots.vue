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
    schema: z.object({
      zipCode: z.string().regex(/^\d{5}$/, 'Enter a 5-digit ZIP'),
      state: z.enum(['CA', 'NY', 'TX', 'WA', 'IL']),
      tier: z.enum(['basic', 'pro', 'enterprise']),
    }),
    defaultValues: { zipCode: '', state: 'CA', tier: 'basic' },
    key: 'docs-demo-slots-pricing-us',
  })
  const pricingEU = useForm({
    schema: z.object({
      vatId: z
        .string()
        .regex(/^[A-Z]{2}[A-Z0-9]{8,12}$/, 'Enter a valid EU VAT ID (e.g. DE123456789)'),
      countryCode: z.enum(['DE', 'FR', 'IT', 'ES', 'NL']),
      tier: z.enum(['basic', 'pro', 'enterprise']),
    }),
    defaultValues: { vatId: '', countryCode: 'DE', tier: 'basic' },
    key: 'docs-demo-slots-pricing-eu',
  })
  const pricingAPAC = useForm({
    schema: z.object({
      gstNumber: z.string().regex(/^[A-Z0-9]{8,15}$/, 'Enter your GST number'),
      country: z.enum(['JP', 'AU', 'SG', 'IN']),
      tier: z.enum(['basic', 'pro', 'enterprise']),
    }),
    defaultValues: { gstNumber: '', country: 'JP', tier: 'basic' },
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

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-pricing-us'" @submit.prevent>
      <p class="muted">
        Sales tax determined by ZIP. The schema below is specific to the US pricing form.
      </p>
      <label>
        <span>ZIP code <span class="required" aria-hidden="true">*</span></span>
        <input
          v-register="pricingUS.register('zipCode')"
          inputmode="numeric"
          maxlength="5"
          placeholder="94110"
        />
        <em v-if="pricingUS.fields.zipCode.showErrors">{{
          pricingUS.fields.zipCode.firstError?.message
        }}</em>
      </label>
      <label>
        State
        <select v-register="pricingUS.register('state')">
          <option value="CA">California</option>
          <option value="NY">New York</option>
          <option value="TX">Texas</option>
          <option value="WA">Washington</option>
          <option value="IL">Illinois</option>
        </select>
      </label>
      <label>
        Tier
        <select v-register="pricingUS.register('tier')">
          <option value="basic">Basic ($19/mo)</option>
          <option value="pro">Pro ($49/mo)</option>
          <option value="enterprise">Enterprise ($199/mo)</option>
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

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-pricing-eu'" @submit.prevent>
      <p class="muted">
        EU customers fill out a VAT registration number. The schema is structurally different from
        the US form.
      </p>
      <label>
        <span>EU VAT ID <span class="required" aria-hidden="true">*</span></span>
        <input v-register="pricingEU.register('vatId')" placeholder="DE123456789" />
        <em v-if="pricingEU.fields.vatId.showErrors">{{
          pricingEU.fields.vatId.firstError?.message
        }}</em>
      </label>
      <label>
        Country
        <select v-register="pricingEU.register('countryCode')">
          <option value="DE">Germany</option>
          <option value="FR">France</option>
          <option value="IT">Italy</option>
          <option value="ES">Spain</option>
          <option value="NL">Netherlands</option>
        </select>
      </label>
      <label>
        Tier
        <select v-register="pricingEU.register('tier')">
          <option value="basic">Basic (€18/mo, incl. VAT)</option>
          <option value="pro">Pro (€45/mo, incl. VAT)</option>
          <option value="enterprise">Enterprise (€180/mo, incl. VAT)</option>
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
          Each region's form has its own schema. The lazy resolver re-fires when the region changes;
          reset clears every lazy cache at once.
        </p>
      </div>
    </form>

    <form v-else-if="wizard.currentStep === 'docs-demo-slots-pricing-apac'" @submit.prevent>
      <p class="muted">
        APAC customers register with a GST number. Tiers price in USD; the schema is again distinct.
      </p>
      <label>
        <span>GST number <span class="required" aria-hidden="true">*</span></span>
        <input v-register="pricingAPAC.register('gstNumber')" placeholder="29ABCDE1234F1Z5" />
        <em v-if="pricingAPAC.fields.gstNumber.showErrors">{{
          pricingAPAC.fields.gstNumber.firstError?.message
        }}</em>
      </label>
      <label>
        Country
        <select v-register="pricingAPAC.register('country')">
          <option value="JP">Japan</option>
          <option value="AU">Australia</option>
          <option value="SG">Singapore</option>
          <option value="IN">India</option>
        </select>
      </label>
      <label>
        Tier
        <select v-register="pricingAPAC.register('tier')">
          <option value="basic">Basic ($19/mo USD)</option>
          <option value="pro">Pro ($49/mo USD)</option>
          <option value="enterprise">Enterprise ($199/mo USD)</option>
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
          Switching regions builds the right schema. The probe shows the lazy resolver re-firing on
          dep changes, and reset clears every lazy cache at once.
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
