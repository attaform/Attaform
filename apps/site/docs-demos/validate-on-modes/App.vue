<script setup lang="ts">
  import { useForm } from 'attaform'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    handle: z.string().min(3, 'At least 3 characters'),
  })

  const changeForm = useForm({
    schema,
    key: 'docs-demo-validate-on-change',
    validateOn: 'change',
    defaultValues: { handle: 'ada' },
  })
  const blurForm = useForm({
    schema,
    key: 'docs-demo-validate-on-blur',
    validateOn: 'blur',
    defaultValues: { handle: 'ada' },
  })
  const submitForm = useForm({
    schema,
    key: 'docs-demo-validate-on-submit',
    validateOn: 'submit',
    defaultValues: { handle: 'ada' },
  })

  const modes = [
    {
      mode: 'change',
      form: changeForm,
      onSubmit: changeForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks on every keystroke.',
    },
    {
      mode: 'blur',
      form: blurForm,
      onSubmit: blurForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks when the field loses focus.',
    },
    {
      mode: 'submit',
      form: submitForm,
      onSubmit: submitForm.handleSubmit((values) =>
        toast.success('Submitted', { description: values })
      ),
      caption: 'Checks only when you submit.',
    },
  ]
</script>

<template>
  <div class="demo layout">
    <p class="lede">
      The same schema runs in all three. What changes is <em>when</em>. Each starts with a valid
      handle: shorten one to a character or two, then tab away or submit. Each panel reports two
      things, and they move at different moments.
    </p>

    <div class="layout split3">
      <section v-for="item in modes" :key="item.mode" class="card">
        <section>
          <code>validateOn: '{{ item.mode }}'</code>
          <p class="hint">{{ item.caption }}</p>
        </section>

        <form class="stack" @submit="item.onSubmit">
          <label>
            Handle
            <input
              v-register="item.form.register('handle')"
              placeholder="3+ characters"
              autocomplete="off"
              spellcheck="false"
            />
          </label>
          <button type="submit">Submit</button>
        </form>

        <section>
          <p class="hint"><code>firstError</code>: the schema's verdict</p>
          <div class="banner" :class="{ error: item.form.fields.handle.firstError }">
            {{ item.form.fields.handle.firstError?.message ?? 'No error' }}
          </div>

          <p class="hint"><code>showErrors</code>: what you would render</p>
          <div class="banner" :class="{ error: item.form.fields.handle.showErrors }">
            {{
              item.form.fields.handle.showErrors
                ? (item.form.fields.handle.firstError?.message ?? 'Error')
                : 'Nothing shown yet'
            }}
          </div>
        </section>
      </section>
    </div>

    <p class="hint">
      An error is a property of the schema, not of the interaction. <code>firstError</code> answers
      as soon as that panel's mode validates, which is what these three columns differ on.
      <code>showErrors</code> is the separate decision of whether the user should see it yet, and it
      waits for a blur or a submit in every column. Bind <code>showErrors</code> in real UI: the
      reveal rhythm comes with it, and the verdict stays readable whenever you need it.
    </p>
  </div>
</template>
