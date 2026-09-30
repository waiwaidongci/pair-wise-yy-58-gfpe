import { ApolloClient, ApolloLink, InMemoryCache, gql } from '@apollo/client/core';

export const LIFT_PLAN_QUERY = gql`
  query LiftPlan($id: ID!) {
    liftPlan(id: $id) {
      id
      name
      revision
      status
      steps {
        id
        name
        loadRate
        clearance
      }
    }
  }
`;

export const graphqlClient = new ApolloClient({
  cache: new InMemoryCache(),
  link: ApolloLink.empty()
});

graphqlClient.writeQuery({
  query: LIFT_PLAN_QUERY,
  variables: { id: 'LP-2026-0918' },
  data: {
    liftPlan: {
      __typename: 'LiftPlan',
      id: 'LP-2026-0918',
      name: '东塔转换桁架吊装',
      revision: 4,
      status: 'REVIEW',
      steps: []
    }
  }
});
