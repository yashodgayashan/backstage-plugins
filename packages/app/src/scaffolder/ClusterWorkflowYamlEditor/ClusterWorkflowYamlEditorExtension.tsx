import { useEffect, useState, useCallback } from 'react';
import { FieldExtensionComponentProps } from '@backstage/plugin-scaffolder-react';
import type { FieldValidation } from '@rjsf/utils';
import { YamlEditor } from '@openchoreo/backstage-plugin-react';
import YAML from 'yaml';
import { useStyles } from './styles';

const DEFAULT_CLUSTER_WORKFLOW_TEMPLATE = {
  apiVersion: 'openchoreo.dev/v1alpha1',
  kind: 'ClusterWorkflow',
  metadata: {
    name: '',
    annotations: {} as Record<string, string>,
    labels: {} as Record<string, string>,
  },
  spec: {
    workflowPlaneRef: {
      kind: 'ClusterWorkflowPlane',
      name: 'default',
    },
    ttlAfterCompletion: '1d',
    parameters: {
      ocSchema: {
        repository: {
          url: 'string | description="Git repository URL"',
          secretRef:
            'string | default="" description="Secret reference name for Git credentials"',
          revision: {
            branch:
              'string | default=main description="Git branch to checkout"',
            commit:
              'string | default="" description="Git commit SHA or reference (optional, defaults to latest)"',
          },
          appPath:
            'string | default=. description="Path to the application directory within the repository"',
        },
        docker: {
          context:
            'string | default=. description="Docker build context path relative to the repository root"',
          filePath:
            'string | default=./Dockerfile description="Path to the Dockerfile relative to the repository root"',
        },
      },
    },
    runTemplate: {
      apiVersion: 'argoproj.io/v1alpha1',
      kind: 'Workflow',
      metadata: {
        name: '${metadata.workflowRunName}',
        namespace: '${metadata.namespace}',
      },
      spec: {
        arguments: {
          parameters: [
            {
              name: 'component-name',
              value: "${metadata.labels['openchoreo.dev/component']}",
            },
            {
              name: 'project-name',
              value: "${metadata.labels['openchoreo.dev/project']}",
            },
            {
              name: 'workflowrun-name',
              value: '${metadata.workflowRunName}',
            },
            {
              name: 'namespace-name',
              value: '${metadata.namespaceName}',
            },
            { name: 'git-repo', value: '${parameters.repository.url}' },
            {
              name: 'branch',
              value: '${parameters.repository.revision.branch}',
            },
            {
              name: 'commit',
              value: '${parameters.repository.revision.commit}',
            },
            { name: 'app-path', value: '${parameters.repository.appPath}' },
            {
              name: 'docker-context',
              value: '${parameters.docker.context}',
            },
            {
              name: 'dockerfile-path',
              value: '${parameters.docker.filePath}',
            },
            {
              name: 'image-name',
              value:
                "${metadata.namespaceName}-${metadata.labels['openchoreo.dev/project']}-${metadata.labels['openchoreo.dev/component']}",
            },
            { name: 'image-tag', value: 'v1' },
            {
              name: 'git-secret',
              value: '${metadata.workflowRunName}-git-secret',
            },
            {
              name: 'registry-push-secret',
              value: '${metadata.workflowRunName}-registry-push-secret',
            },
          ] as Array<{ name: string; value: string }>,
        },
        serviceAccountName: 'workflow-sa',
        entrypoint: 'build-workflow',
        templates: [
          {
            name: 'build-workflow',
            steps: [
              [
                {
                  name: 'checkout-source',
                  templateRef: {
                    name: 'checkout-source',
                    clusterScope: true,
                    template: 'checkout',
                  },
                },
              ],
              [
                {
                  name: 'build-image',
                  templateRef: {
                    name: 'docker',
                    clusterScope: true,
                    template: 'build-image',
                  },
                  arguments: {
                    parameters: [
                      {
                        name: 'git-revision',
                        value:
                          '{{steps.checkout-source.outputs.parameters.git-revision}}',
                      },
                    ],
                  },
                },
              ],
              [
                {
                  name: 'publish-image',
                  templateRef: {
                    name: 'publish-image',
                    clusterScope: true,
                    template: 'publish-image',
                  },
                  arguments: {
                    parameters: [
                      {
                        name: 'git-revision',
                        value:
                          '{{steps.checkout-source.outputs.parameters.git-revision}}',
                      },
                    ],
                  },
                },
              ],
              [
                {
                  name: 'generate-workload-cr',
                  templateRef: {
                    name: 'generate-workload',
                    clusterScope: true,
                    template: 'generate-workload-cr',
                  },
                  arguments: {
                    parameters: [
                      {
                        name: 'image',
                        value:
                          '{{steps.publish-image.outputs.parameters.image}}',
                      },
                      {
                        name: 'run-name',
                        value: '{{workflow.parameters.workflowrun-name}}',
                      },
                    ],
                  },
                },
              ],
            ],
          },
        ],
        volumeClaimTemplates: [
          {
            metadata: { name: 'workspace' },
            spec: {
              accessModes: ['ReadWriteOnce'],
              resources: { requests: { storage: '2Gi' } },
            },
          },
        ],
      },
    },
    externalRefs: [
      {
        id: 'git-secret-reference',
        apiVersion: 'openchoreo.dev/v1alpha1',
        kind: 'SecretReference',
        name: '${parameters.repository.secretRef}',
      },
    ],
    resources: [
      {
        id: 'git-secret',
        includeWhen:
          '${has(parameters.repository.secretRef) && parameters.repository.secretRef != ""}',
        template: {
          apiVersion: 'external-secrets.io/v1',
          kind: 'ExternalSecret',
          metadata: {
            name: '${metadata.workflowRunName}-git-secret',
            namespace: '${metadata.namespace}',
          },
          spec: {
            refreshInterval: '15s',
            secretStoreRef: {
              kind: 'ClusterSecretStore',
              name: 'default',
            },
            target: {
              name: '${metadata.workflowRunName}-git-secret',
              creationPolicy: 'Owner',
              template: {
                type: "${externalRefs['git-secret-reference'].spec.template.type}",
              },
            },
            data: `\${externalRefs['git-secret-reference'].spec.data.map(secret, {
  "secretKey": secret.secretKey,
  "remoteRef": {
    "key": secret.remoteRef.key,
    "property": has(secret.remoteRef.property) && secret.remoteRef.property != "" ? secret.remoteRef.property : oc_omit()
  }
})}`,
          },
        },
      },
      {
        id: 'registry-push-secret',
        template: {
          apiVersion: 'external-secrets.io/v1',
          kind: 'ExternalSecret',
          metadata: {
            name: '${metadata.workflowRunName}-registry-push-secret',
            namespace: '${metadata.namespace}',
          },
          spec: {
            refreshInterval: '15s',
            secretStoreRef: {
              name: 'default',
              kind: 'ClusterSecretStore',
            },
            target: {
              name: '${metadata.workflowRunName}-registry-push-secret',
              creationPolicy: 'Owner',
              template: {
                type: 'kubernetes.io/dockerconfigjson',
                data: {
                  '.dockerconfigjson':
                    '{{ .registrysecret | toString }}',
                },
              },
            },
            data: [
              {
                secretKey: 'registrysecret',
                remoteRef: {
                  key: 'registry-push-secret',
                  property: 'value',
                },
              },
            ],
          },
        },
      },
    ],
  },
};

function generateInitialYaml(formData: Record<string, unknown>): string {
  const name = (formData?.clusterworkflow_name as string) || '';
  const displayName = (formData?.displayName as string) || '';
  const description = (formData?.description as string) || '';
  const isComponentWorkflow = formData?.is_component_workflow === true;

  const template = structuredClone(DEFAULT_CLUSTER_WORKFLOW_TEMPLATE);
  template.metadata.name = name;
  if (displayName) {
    template.metadata.annotations['openchoreo.dev/display-name'] = displayName;
  }
  if (description) {
    template.metadata.annotations['openchoreo.dev/description'] = description;
  }
  if (isComponentWorkflow) {
    template.metadata.labels['openchoreo.dev/workflow-type'] = 'component';
  }

  return YAML.stringify(template, { indent: 2 });
}

export const ClusterWorkflowYamlEditorExtension = ({
  onChange,
  rawErrors,
  formContext,
  formData,
}: FieldExtensionComponentProps<string>) => {
  const classes = useStyles();
  const [errorText, setErrorText] = useState<string | undefined>();

  const isComponentWorkflow =
    formContext?.formData?.is_component_workflow === true;

  // Generate initial YAML or sync workflow-type label on mount.
  // This runs each time the step mounts (e.g., navigating back and forth between steps).
  useEffect(() => {
    if (!formContext?.formData) {
      return;
    }

    if (!formData) {
      // No existing YAML — generate from scratch
      const initialYaml = generateInitialYaml(formContext.formData);
      onChange(initialYaml);
      return;
    }

    // Existing YAML — sync the workflow-type label with the toggle
    try {
      const parsed = YAML.parse(formData);
      if (!parsed?.metadata) {
        return;
      }
      if (!parsed.metadata.labels) {
        parsed.metadata.labels = {};
      }

      const hasLabel =
        parsed.metadata.labels['openchoreo.dev/workflow-type'] === 'component';

      if (isComponentWorkflow && !hasLabel) {
        parsed.metadata.labels['openchoreo.dev/workflow-type'] = 'component';
        onChange(YAML.stringify(parsed, { indent: 2 }));
      } else if (!isComponentWorkflow && hasLabel) {
        delete parsed.metadata.labels['openchoreo.dev/workflow-type'];
        onChange(YAML.stringify(parsed, { indent: 2 }));
      }
    } catch {
      // If YAML is invalid, don't try to sync
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleChange = useCallback(
    (content: string) => {
      onChange(content);

      // Validate YAML on change
      try {
        YAML.parse(content);
        setErrorText(undefined);
      } catch (err) {
        setErrorText(`YAML parse error: ${err}`);
      }
    },
    [onChange],
  );

  const content = formData || '';

  return (
    <div>
      <div className={classes.helpText}>
        <span>
          Customize the ClusterWorkflow definition below. This resource is
          cluster-scoped and shared across all namespaces. For available fields
          and configuration options, see the{' '}
          <a
            className={classes.helpLink}
            href="https://openchoreo.dev/docs/reference/api/platform/clusterworkflow/"
            target="_blank"
            rel="noopener noreferrer"
          >
            ClusterWorkflow documentation
          </a>
          .
        </span>
      </div>
      <div className={classes.container}>
        <YamlEditor
          content={content}
          onChange={handleChange}
          errorText={errorText}
        />
      </div>
      {rawErrors && rawErrors.length > 0 && (
        <div className={classes.errorText}>{rawErrors.join(', ')}</div>
      )}
    </div>
  );
};

export const clusterWorkflowYamlEditorValidation = (
  value: string,
  validation: FieldValidation,
) => {
  if (!value || value.trim() === '') {
    validation.addError('ClusterWorkflow YAML definition is required');
    return;
  }

  try {
    const parsed = YAML.parse(value);
    if (!parsed || typeof parsed !== 'object') {
      validation.addError('YAML content must be a valid object');
      return;
    }
    if (parsed.kind !== 'ClusterWorkflow') {
      validation.addError('Kind must be ClusterWorkflow');
    }
    if (!parsed.apiVersion) {
      validation.addError('apiVersion is required');
    }
    if (!parsed.metadata?.name) {
      validation.addError('metadata.name is required');
    }
  } catch (err) {
    validation.addError(`Invalid YAML: ${err}`);
  }
};
