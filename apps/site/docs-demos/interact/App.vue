<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    team: z.string().min(1, 'Name your team'),
    members: z.array(
      z.object({
        name: z.string().min(1, 'Every member needs a name'),
        email: z.string().email('Enter a valid email'),
      })
    ),
  })

  const form = useForm({
    schema,
    key: 'docs-demo-interact',
    defaultValues: {
      team: '',
      members: [
        { name: 'Ada', email: 'ada@team.dev' },
        { name: '', email: 'not-an-email' },
      ],
    },
  })
</script>

<template>
  <form class="demo" @submit.prevent>
    <p class="hint">
      These values arrived from an import, so nobody has focused, edited, or left a single field.
      Every row sits at <code>idle</code> even though row 2 is invalid.
    </p>

    <label>
      <span>
        Team
        <span class="badge" :class="form.fields('team').displayState">{{
          form.fields('team').displayState
        }}</span>
      </span>
      <input v-register="form.register('team')" />
      <small v-if="form.fields.team.showErrors" class="message error">{{
        form.fields.team.firstError?.message
      }}</small>
    </label>

    <fieldset v-for="(member, i) in form.list('members')" :key="member.key">
      <legend>
        Member {{ i + 1 }}
        <span class="badge" :class="form.fields(['members', i]).displayState">{{
          form.fields(['members', i]).displayState
        }}</span>
      </legend>

      <label>
        <span>Name</span>
        <input v-register="form.register(['members', i, 'name'])" />
        <small v-if="form.fields(['members', i, 'name']).showErrors" class="message error">{{
          form.fields(['members', i, 'name']).firstError?.message
        }}</small>
      </label>

      <label>
        <span>Email</span>
        <input v-register="form.register(['members', i, 'email'])" />
        <small v-if="form.fields(['members', i, 'email']).showErrors" class="message error">{{
          form.fields(['members', i, 'email']).firstError?.message
        }}</small>
      </label>

      <div class="actions mono">
        <button type="button" @click="form.interact(['members', i])">
          form.interact(['members', {{ i }}])
        </button>
      </div>
    </fieldset>

    <div class="actions mono">
      <button type="button" class="primary" @click="form.interact()">form.interact()</button>
      <button type="button" class="ghost" @click="form.reset()">form.reset()</button>
    </div>

    <p class="hint">
      Checking one member arms only that row: its errors appear while the other member and the Team
      field stay <code>idle</code>. That scoping is the difference from a submit, which would light
      up every field at once. <code>form.interact()</code> with no path does exactly that for the
      whole form, and <code>form.reset()</code> clears the flags again. Member 1 is already valid,
      so checking it greens: <code>form.interact</code> declares the row engaged, and the success
      check rewards engagement rather than a changed value. A row nobody has checked stays
      <code>idle</code> either way.
    </p>
  </form>
</template>
