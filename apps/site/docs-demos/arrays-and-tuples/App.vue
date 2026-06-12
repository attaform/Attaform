<script setup lang="ts">
  import { useForm } from 'attaform/zod'
  import { z } from 'zod'
  import './styles.css'

  const schema = z.object({
    todos: z.array(
      z.object({
        title: z.string().min(1, 'Title is required'),
        done: z.boolean(),
      })
    ),
    dateRange: z.tuple([z.string(), z.string()]),
  })

  const form = useForm({
    schema,
    defaultValues: {
      todos: [
        { title: 'Ship cluster 1', done: true },
        { title: 'Ship cluster 2', done: false },
      ],
      dateRange: ['2026-05-01', '2026-05-31'],
    },
    key: 'docs-demo-arrays-and-tuples',
  })

  function addTodo() {
    form.append('todos', { title: '', done: false })
  }
</script>

<template>
  <form class="demo" @submit.prevent>
    <fieldset>
      <legend>z.array (variable length)</legend>
      <div v-for="(_, i) in form.values.todos" :key="i" class="row">
        <input v-register="form.register(`todos.${i}.title`)" placeholder="Title" />
        <label class="row compact">
          <input v-register="form.register(`todos.${i}.done`)" type="checkbox" />
          done
        </label>
        <button type="button" class="ghost" @click="form.remove('todos', i)">−</button>
      </div>
      <button type="button" class="ghost add" @click="addTodo">+ Add todo</button>
    </fieldset>

    <fieldset>
      <legend>z.tuple (fixed length [start, end])</legend>
      <label>
        Start
        <input v-register="form.register('dateRange.0')" type="date" />
      </label>
      <label>
        End
        <input v-register="form.register('dateRange.1')" type="date" />
      </label>
    </fieldset>

    <pre>{{ JSON.stringify(form.values, (_, v) => (v === undefined ? '(undefined)' : v), 2) }}</pre>
  </form>
</template>

<style scoped>
  .row input:not([type='checkbox']) {
    flex: 1;
  }
</style>
